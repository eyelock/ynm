# Local MinIO

A local S3 for building and trying the `s3` provider without an AWS account. It runs MinIO in
Docker with one versioned bucket. It is for development only: fixed credentials, plain HTTP, and
no data kept after `make minio-down`.

```sh
make minio              # start it, wait, create the bucket
eval "$(make minio-env)"  # this shell now mounts the bucket as the distributed store
make minio-down         # stop it and throw its data away
```

| Thing | Value |
|---|---|
| Endpoint | `http://localhost:9000` (`MINIO_PORT` to change) |
| Credentials | `ynm` / `ynm-dev-secret` |
| Bucket | `ynm-dev`, versioned (`MINIO_BUCKET` to change) |
| Mount | `hosted`, level `distributed`, prefix `dev` |

`make minio-env` prints the AWS variables and a `YNM_MOUNTS` value. They only affect the shell
that evaluates them; set `YNM_HOME` to a scratch directory as well to keep your own personal
store out of the experiment. Running a server against it is in
[CONTRIBUTING.md](../../CONTRIBUTING.md#run-the-server-locally).
