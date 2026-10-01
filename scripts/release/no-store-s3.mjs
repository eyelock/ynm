// Stands in for @ynm/store-s3 in the release bundles (scripts/release/bundle.mjs), so the AWS SDK
// never enters them. Loading it fails the way a missing package does; the service turns that
// into a plain message for the mount that asked for the s3 provider.
throw Object.assign(new Error("@ynm/store-s3 is not part of this build"), {
  code: "ERR_MODULE_NOT_FOUND",
});
