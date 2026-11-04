terraform {
  required_version = ">= 1.8.0, < 2.0.0"
  required_providers {
    docker = {
      source = "kreuzwerker/docker"
      version = "3.9.0"
    }
  }
}
provider "docker" { host = "unix:///var/run/docker.sock" }
variable "owner" {
  type = string
  validation {
    condition = can(regex("^[a-f0-9]{32}$", var.owner))
    error_message = "A unique runtime owner is required."
  }
}
resource "docker_volume" "backing" {
  name = "agent-runtime-disk-${var.owner}"
  labels {
    label = "agent-runtime.owner"
    value = var.owner
  }
}
output "volume_name" { value = docker_volume.backing.name }
