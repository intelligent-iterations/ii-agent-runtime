terraform {
  required_version = ">= 1.9, < 2.0"
}
variable "manifest_path" { type = string }
variable "node_binary" { type = string }
variable "hook_script" { type = string }

resource "terraform_data" "vm" {
  input = {
    manifest_path = var.manifest_path
    node_binary   = var.node_binary
    hook_script   = var.hook_script
  }
  lifecycle {
    ignore_changes = [input]
  }
  provisioner "local-exec" {
    command = "\"$RUNTIME_NODE\" \"$RUNTIME_HOOK\" create \"$RUNTIME_MANIFEST\""
    environment = {
      RUNTIME_NODE     = self.input.node_binary
      RUNTIME_HOOK     = self.input.hook_script
      RUNTIME_MANIFEST = self.input.manifest_path
    }
  }
  provisioner "local-exec" {
    when    = destroy
    command = "\"$RUNTIME_NODE\" \"$RUNTIME_HOOK\" remove \"$RUNTIME_MANIFEST\""
    environment = {
      RUNTIME_NODE     = self.input.node_binary
      RUNTIME_HOOK     = self.input.hook_script
      RUNTIME_MANIFEST = self.input.manifest_path
    }
  }
}
output "operation" { value = terraform_data.vm.output }
