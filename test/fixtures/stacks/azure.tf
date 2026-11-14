# Excerpt of stacks/azure/main.tf at 30-apps-infra 5e5ad6a
  location                      = var.pg_location
  version                       = "16"
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  backup_retention_days         = 7
# ...
      name   = "app"
      image  = "${each.value.image}:${each.value.tag}"
      cpu    = 0.25
      memory = "0.5Gi"

