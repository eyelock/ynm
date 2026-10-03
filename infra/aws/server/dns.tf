resource "aws_route53_record" "store" {
  count = var.dns_zone_name == null ? 0 : 1

  zone_id = data.aws_route53_zone.public[0].zone_id
  name    = local.hostname
  type    = "A"
  ttl     = 300
  records = [aws_eip.server.public_ip]
}
