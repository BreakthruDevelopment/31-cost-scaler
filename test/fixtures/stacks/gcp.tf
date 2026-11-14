# Excerpt of stacks/gcp/main.tf at 30-apps-infra 5e5ad6a
  name         = "postgres"
  machine_type = "e2-micro" # always-free in us-central1, us-east1, us-west1
  zone         = "${var.region}-a"
# ...
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # billed only while handling requests
        startup_cpu_boost = false
