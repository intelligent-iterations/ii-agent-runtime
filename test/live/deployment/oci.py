"""Invoked by oci-emulator Go test; CloudEmu owns a fresh, versioned OCI wire server."""

import base64
import os
import subprocess
from emulator_http import request
from iac_test import Deployment

endpoint = os.environ["II_OCI_EMULATOR_ENDPOINT"]
test = Deployment("oci", "cloudemu@a624a9526f7b55686218532b5282be99e176984f")
compartment = "ocid1.tenancy.oc1..aaaaaaaacloudemulocaltenancy"
base = "/20160918"


def api(method, path, body=None):
    return request(endpoint, method, base + path, body)


try:
    vcn = api(
        "POST",
        "/vcns",
        {
            "compartmentId": compartment,
            "cidrBlock": "10.42.0.0/16",
            "displayName": "ii-emulator",
        },
    )
    subnet = api(
        "POST",
        "/subnets",
        {"compartmentId": compartment, "vcnId": vcn["id"], "cidrBlock": "10.42.1.0/24"},
    )
    images = api("GET", "/images?compartmentId=" + compartment)
    assert images
    subprocess.run(
        ["openssl", "genrsa", "-out", str(test.parent / "synthetic-key.pem"), "2048"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            str(test.parent / "synthetic-ssh"),
        ],
        check=True,
    )
    ssh_key = (test.parent / "synthetic-ssh.pub").read_text().strip()
    test.prepare(
        {
            "schemaVersion": 1,
            "id": "emulated-agent",
            "provider": "oci",
            "infrastructure": {
                "availability_domain": "cloudemu:US-ASHBURN-1-AD-1",
                "compartment_id": compartment,
                "shape": "VM.Standard.E4.Flex",
                "shape_config": [{"ocpus": 2, "memory_in_gbs": 8}],
                "source_details": [
                    {"source_type": "image", "source_id": images[0]["id"]}
                ],
                "create_vnic_details": [
                    {"subnet_id": subnet["id"], "assign_public_ip": False}
                ],
                "ssh_authorized_keys": ssh_key,
            },
            "providerConfiguration": {"region": "us-ashburn-1"},
        },
        "oci",
        {
            "tenancy_ocid": compartment,
            "user_ocid": "ocid1.user.oc1..synthetic",
            "fingerprint": "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
            "private_key_path": str(test.parent / "synthetic-key.pem"),
        },
    )
    test.environment["TF_VAR_CLIENT_HOST_OVERRIDES"] = ";".join(
        client + "=" + endpoint
        for client in [
            "oci_core.ComputeClient",
            "oci_core.VirtualNetworkClient",
            "oci_core.BlockstorageClient",
            "oci_identity.IdentityClient",
        ]
    )
    output = test.operate("apply")["outputs"]
    instance_id = output["instance_id"]["value"]
    assert output["address"]["value"]
    instance = api("GET", "/instances/" + instance_id)
    assert instance["lifecycleState"] == "RUNNING"
    assert instance["metadata"]["ssh_authorized_keys"] == ssh_key
    assert "docker.io" in base64.b64decode(instance["metadata"]["user_data"]).decode()
    test.result["createReadback"] = "passed"
    test.operate("destroy")
    test.assert_empty_state()
    remaining = api("GET", "/instances?compartmentId=" + compartment)
    assert all(item["lifecycleState"] == "TERMINATED" for item in remaining)
    vnics = api("GET", "/vnicAttachments?compartmentId=" + compartment)
    assert all(item["lifecycleState"] == "DETACHED" for item in vnics)
    api("DELETE", "/subnets/" + subnet["id"])
    api("DELETE", "/vcns/" + vcn["id"])
    test.result.update(
        status="passed", savedPlanDestroy="passed", resourceCleanup="passed"
    )
finally:
    test.record()
