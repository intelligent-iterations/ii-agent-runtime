import type { HostDeployment } from '../../deployment/contracts.js';

type Value = string | number | boolean | unknown[] | Record<string, unknown>;
type Resource = Record<string, Value>;
export interface VirtualMachineAdapter {
  source: string;
  version: string;
  localName: string;
  resource: string;
  required: string[];
  optional: string[];
  providerFields: string[];
  configure(name: string, input: Resource, userData: string): Resource;
  address: string;
}
const ref = (value: string) => '${' + value + '}';
export const virtualMachines: Record<string, VirtualMachineAdapter> = {
  aws: {
    source: 'hashicorp/aws',
    version: '6.70.0',
    localName: 'aws',
    resource: 'aws_instance',
    required: ['ami', 'instance_type', 'subnet_id', 'vpc_security_group_ids', 'key_name'],
    optional: ['associate_public_ip_address', 'root_block_device'],
    providerFields: ['region'],
    configure: (name, input, userData) => ({
      ...input,
      user_data: userData,
      metadata_options: [{ http_endpoint: 'enabled', http_tokens: 'required', http_put_response_hop_limit: 1 }],
      tags: { Name: name },
    }),
    address: 'private_ip',
  },
  azure: {
    source: 'hashicorp/azurerm',
    version: '5.11.0',
    localName: 'azurerm',
    resource: 'azurerm_linux_virtual_machine',
    required: [
      'location',
      'resource_group_name',
      'size',
      'network_interface_ids',
      'admin_username',
      'admin_ssh_key',
      'source_image_id',
    ],
    optional: ['zone'],
    providerFields: ['subscription_id', 'tenant_id'],
    configure: (name, input, userData) => ({
      ...input,
      name,
      disable_password_authentication: true,
      custom_data: Buffer.from(userData).toString('base64'),
      os_disk: [{ caching: 'ReadWrite', storage_account_type: 'Standard_LRS' }],
    }),
    address: 'private_ip_address',
  },
  gcp: {
    source: 'hashicorp/google',
    version: '8.8.1',
    localName: 'google',
    resource: 'google_compute_instance',
    required: ['zone', 'machine_type', 'boot_disk', 'network_interface'],
    optional: ['tags'],
    providerFields: ['project', 'region'],
    configure: (name, input, userData) => ({
      ...input,
      name,
      metadata: { 'user-data': userData, 'block-project-ssh-keys': 'TRUE', 'enable-oslogin': 'TRUE' },
      shielded_instance_config: [{ enable_secure_boot: true, enable_vtpm: true, enable_integrity_monitoring: true }],
    }),
    address: 'network_interface[0].network_ip',
  },
  oci: {
    source: 'oracle/oci',
    version: '9.11.0',
    localName: 'oci',
    resource: 'oci_core_instance',
    required: [
      'availability_domain',
      'compartment_id',
      'shape',
      'source_details',
      'create_vnic_details',
      'ssh_authorized_keys',
    ],
    optional: ['shape_config'],
    providerFields: ['region'],
    configure: (name, input, userData) => {
      const { ssh_authorized_keys, ...fields } = input;
      return {
        ...fields,
        display_name: name,
        metadata: { user_data: Buffer.from(userData).toString('base64'), ssh_authorized_keys },
      };
    },
    address: 'private_ip',
  },
  digitalocean: {
    source: 'digitalocean/digitalocean',
    version: '2.106.0',
    localName: 'digitalocean',
    resource: 'digitalocean_droplet',
    required: ['region', 'size', 'image', 'ssh_keys', 'vpc_uuid'],
    optional: ['tags'],
    providerFields: [],
    configure: (name, input, userData) => ({ ...input, name, user_data: userData, monitoring: true }),
    address: 'ipv4_address_private',
  },
  hetzner: {
    source: 'hetznercloud/hcloud',
    version: '1.70.1',
    localName: 'hcloud',
    resource: 'hcloud_server',
    required: ['location', 'server_type', 'image', 'ssh_keys', 'firewall_ids'],
    optional: ['network'],
    providerFields: [],
    configure: (name, input, userData) => ({ ...input, name, user_data: userData }),
    address: 'ipv4_address',
  },
};

/** Terraform JSON still interpolates strings. User data and literal configuration must never become expressions. */
export function terraformLiteral(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('${', () => '$${').replaceAll('%{', '%%{');
  if (Array.isArray(value)) return value.map(terraformLiteral);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, terraformLiteral(item)]));
  return value;
}
export function virtualMachineDocument(declaration: HostDeployment, userData: string): object {
  const adapter = virtualMachines[declaration.provider]!;
  for (const field of adapter.required)
    if (declaration.infrastructure[field] === undefined)
      throw Error(`${declaration.provider} requires infrastructure.${field}`);
  for (const field of Object.keys(declaration.infrastructure))
    if (![...adapter.required, ...adapter.optional].includes(field))
      throw Error(`Unsupported ${declaration.provider} infrastructure field ${field}`);
  for (const field of Object.keys(declaration.providerConfiguration))
    if (!adapter.providerFields.includes(field))
      throw Error(
        `Unsupported ${declaration.provider} provider field ${field}; supply authentication through the environment`,
      );
  return {
    terraform: {
      required_version: '>= 1.8.0, < 2.0.0',
      required_providers: { [adapter.localName]: { source: adapter.source, version: adapter.version } },
    },
    provider: {
      [adapter.localName]: {
        ...(terraformLiteral(declaration.providerConfiguration) as object),
        ...(declaration.provider === 'azure' ? { features: [{}] } : {}),
      },
    },
    resource: {
      [adapter.resource]: {
        host: terraformLiteral(
          adapter.configure(declaration.id, declaration.infrastructure as Resource, userData),
        ),
      },
    },
    output: {
      instance_id: { value: ref(`${adapter.resource}.host.id`) },
      address: {
        value: ref(`${adapter.resource}.host.${adapter.address}`),
      },
    },
  };
}
