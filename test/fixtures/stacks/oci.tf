# Excerpt of stacks/oci/main.tf at 30-apps-infra 5e5ad6a
  shape               = "VM.Standard.A1.Flex"
  freeform_tags       = local.tags

  # The whole Always Free Ampere allowance. Going over it disables every A1 VM in the tenancy.
  shape_config {
    ocpus         = 2
    memory_in_gbs = 12
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = 100 # inside the 200 GB Always Free block storage
  }
