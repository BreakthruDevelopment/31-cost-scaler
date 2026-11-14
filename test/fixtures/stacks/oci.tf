# Excerpt of stacks/oci/main.tf at 30-apps-infra 5e5ad6a (lines kept verbatim, gaps elided)
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}
# ...
resource "oci_core_instance" "host" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = "apps-host"
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
