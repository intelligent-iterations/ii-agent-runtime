import type { HostDeployment } from '../../src/deployment/contracts.js';
const uuid = '11111111-1111-4111-8111-111111111111';
const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICv1rEWkPx17dYFBFcGBUDMwATJYB6Hw3QSEaZc9ZVgR test';
const azure =
  '/subscriptions/' + uuid + '/resourceGroups/example/providers/Microsoft.Network/networkInterfaces/example';
export const infrastructures: Record<string, Record<string, unknown>> = {
  aws: {
    ami: 'ami-0123456789abcdef0',
    instance_type: 't3.medium',
    subnet_id: 'subnet-0123456789abcdef0',
    vpc_security_group_ids: ['sg-0123456789abcdef0'],
    key_name: 'operator',
  },
  azure: {
    location: 'eastus',
    resource_group_name: 'example',
    size: 'Standard_B2s',
    network_interface_ids: [azure],
    admin_username: 'operator',
    admin_ssh_key: [{ username: 'operator', public_key: key }],
    source_image_id: '/subscriptions/' + uuid + '/resourceGroups/example/providers/Microsoft.Compute/images/prepared',
  },
  gcp: {
    zone: 'us-central1-a',
    machine_type: 'e2-standard-2',
    boot_disk: [{ initialize_params: [{ image: 'projects/example/global/images/prepared' }] }],
    network_interface: [{ subnetwork: 'projects/example/regions/us-central1/subnetworks/private' }],
  },
  oci: {
    availability_domain: 'aaaa:US-ASHBURN-AD-1',
    compartment_id: 'ocid1.compartment.oc1..example',
    shape: 'VM.Standard.E4.Flex',
    shape_config: [{ ocpus: 2, memory_in_gbs: 8 }],
    source_details: [{ source_type: 'image', source_id: 'ocid1.image.oc1..example' }],
    create_vnic_details: [{ subnet_id: 'ocid1.subnet.oc1..example', assign_public_ip: false }],
    ssh_authorized_keys: key,
  },
  digitalocean: {
    region: 'nyc3',
    size: 's-2vcpu-4gb',
    image: 'ubuntu-24-04-x64',
    ssh_keys: ['123456'],
    vpc_uuid: uuid,
  },
  hetzner: { location: 'nbg1', server_type: 'cx23', image: 'ubuntu-24.04', ssh_keys: [123], firewall_ids: [123] },
};
export function declaration(provider: string): HostDeployment {
  const configurations: Record<string, object> = {
    aws: { region: 'us-east-1' },
    azure: { subscription_id: uuid },
    gcp: { project: 'example-project', region: 'us-central1' },
    oci: { region: 'us-ashburn-1' },
  };
  return {
    schemaVersion: 1,
    id: 'example-app',
    provider,
    infrastructure: structuredClone(infrastructures[provider] ?? {}),
    providerConfiguration: { ...configurations[provider] },
  };
}
