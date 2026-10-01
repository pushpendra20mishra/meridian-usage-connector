# terraform decides when to re-render, render.ts decides what
# only uses terraform_data, nothing to download
terraform {
  required_version = ">= 1.9"
}

variable "environments" {
  description = "Environments to render. One tfvars file per environment: terraform apply -var-file=envs/prod.tfvars"
  type        = list(string)
  default     = ["dev", "staging", "prod"]
  validation {
    condition     = alltrue([for e in var.environments : contains(["dev", "staging", "prod"], e)])
    error_message = "environments must be a subset of dev, staging, prod."
  }
}

variable "out_dir" {
  description = "Where rendered config is written."
  type        = string
  default     = "../dist"
}

variable "install_root" {
  description = "Path substituted into host configs that need absolute paths. The default placeholder keeps dist/ machine-independent."
  type        = string
  default     = "$${INSTALL_ROOT}"
}

locals {
  repo = abspath("${path.module}/..")
  # files the renderer reads, any change re-renders
  shared_inputs = [
    "provisioning/targets.yaml",
    "provisioning/permissions.schema.json",
    "src/provisioning/render.ts",
    "data/directory/users.json",
    "data/directory/groups.json",
    "contracts/tools.schema.json",
    "plugin-src/GEMINI.md",
    "plugin-src/skills/meridian-usage/SKILL.md",
  ]
  input_hash = {
    for e in var.environments : e => sha256(join("", [
      for f in concat(local.shared_inputs, ["environments/${e}.yaml"]) : filesha256("${local.repo}/${f}")
    ]))
  }
}

resource "terraform_data" "render" {
  for_each         = toset(var.environments)
  triggers_replace = [local.input_hash[each.key], var.out_dir, var.install_root]

  provisioner "local-exec" {
    working_dir = local.repo
    command     = "npx tsx src/provisioning/render.ts --env ${each.key} --out ${var.out_dir} --install-root '${var.install_root}'"
  }
}

output "permissions_manifests" {
  value = { for e in var.environments : e => "${var.out_dir}/${e}/permissions.json" }
}

output "input_hash" {
  value = local.input_hash
}
