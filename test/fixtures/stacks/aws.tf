# Excerpt of stacks/aws/main.tf at 30-apps-infra 5e5ad6a (lines kept verbatim, gaps elided)
  identifier              = "apps30-postgres"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = "db.t4g.micro"
  allocated_storage       = 20
  storage_type            = "gp3"
# ...
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.app[each.key].repository_url}:${each.value.tag}"
  architectures = ["arm64"]
  memory_size   = 1024
