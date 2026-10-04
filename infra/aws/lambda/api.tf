# HTTPS on the client's hostname: an API Gateway HTTP API whose only route sends everything to
# the function (payload format 2.0, the same event a Function URL sends), a certificate for the
# hostname, and the DNS record. The API's own execute-api address is switched off, so the
# hostname is the only way in. ynm verifies tokens itself; the API does no auth.

resource "aws_apigatewayv2_api" "store" {
  name                         = local.name
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = true
}

resource "aws_apigatewayv2_integration" "function" {
  api_id                 = aws_apigatewayv2_api.store.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.server.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "all" {
  api_id    = aws_apigatewayv2_api.store.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.function.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.store.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.throttle.rate
    throttling_burst_limit = var.throttle.burst
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "api-gateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.server.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.store.execution_arn}/*/*"
}

resource "aws_acm_certificate" "store" {
  domain_name       = local.hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate" {
  for_each = {
    for o in aws_acm_certificate.store.domain_validation_options : o.domain_name => o
  }

  zone_id = data.aws_route53_zone.public.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "store" {
  certificate_arn         = aws_acm_certificate.store.arn
  validation_record_fqdns = [for r in aws_route53_record.certificate : r.fqdn]
}

resource "aws_apigatewayv2_domain_name" "store" {
  domain_name = local.hostname

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.store.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "store" {
  api_id      = aws_apigatewayv2_api.store.id
  domain_name = aws_apigatewayv2_domain_name.store.id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "store" {
  zone_id = data.aws_route53_zone.public.zone_id
  name    = local.hostname
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.store.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.store.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
