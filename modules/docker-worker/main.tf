terraform {
  required_version = ">= 1.8.0, < 2.0.0"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "3.9.0"
    }
  }
}

provider "docker" {
  host = "unix:///var/run/docker.sock"
}

variable "canonical_configuration_path" {
  type = string
}

variable "configuration_sha256" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{64}$", var.configuration_sha256))
    error_message = "A canonical configuration SHA-256 is required."
  }
}

variable "resources_sha256" {
  type = string
}

variable "owner" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.owner))
    error_message = "A unique runtime ownership identity is required."
  }
}

locals {
  canonical = file(var.canonical_configuration_path)
  runtime   = jsondecode(local.canonical)
  name      = "agent-runtime-${var.owner}"
}

resource "docker_network" "agent" {
  name     = local.name
  internal = true
  labels {
    label = "agent-runtime.owner"
    value = var.owner
  }
  lifecycle {
    precondition {
      condition     = sha256(local.canonical) == var.resources_sha256
      error_message = "Canonical configuration integrity check failed."
    }
  }
}

resource "docker_image" "agent" {
  name         = local.runtime.environment.image
  keep_locally = false
  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", local.runtime.environment.image))
      error_message = "The worker image must be immutable."
    }
  }
}

resource "docker_container" "agent" {
  name          = local.name
  image         = docker_image.agent.image_id
  user          = "10001:10001"
  read_only     = true
  privileged    = false
  must_run      = true
  restart       = "no"
  network_mode  = "none"
  cpus          = tostring(local.runtime.environment.cpu)
  memory        = local.runtime.environment.memoryMiB
  memory_swap   = local.runtime.environment.memoryMiB
  security_opts = ["no-new-privileges:true"]
  entrypoint    = ["/bin/sleep"]
  command       = [tostring(local.runtime.environment.timeoutSeconds)]
  log_driver    = "none"
  tmpfs = {
    "/tmp"       = "rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001"
    # exec is explicit: Docker mounts tmpfs noexec by default, and builds run installed binaries (esbuild, Rollup, venvs).
    "/workspace" = "rw,exec,nosuid,nodev,size=${local.runtime.environment.memoryMiB}m,uid=10001,gid=10001"
  }
  capabilities {
    drop = ["ALL"]
  }
  labels {
    label = "agent-runtime.owner"
    value = var.owner
  }
  labels {
    label = "agent-runtime.configuration"
    value = var.configuration_sha256
  }
}

output "container_id" {
  value = docker_container.agent.id
}

output "network_id" {
  value = docker_network.agent.id
}

output "owner" {
  value = var.owner
}
