# Hosting the NWM forecast updater on AWS Lambda + S3

What runs where:

    EventBridge timer (every 6 h) ──> Lambda (lambda_handler.py, container image)
                                         │  CIROH API, or the Google bucket if the API has no data
                                         ▼
                              S3: <bucket>/nwm_forecasts/daily/medium_range/<cycle>/0/alabama/YYYYMMDD.parquet
                                         ▲
                     GitHub Pages dashboard reads the small daily file directly (CORS allowed)

The Lambda uses the same code as the laptop updater (`build_run()` in download_medium_range.py,
`plan()` in update_forecasts.py); only the "where to save" part is different.

Replace `ciroh-drought-dashboard` and `858933856877` below (and in the two policy JSON files) with yours.
Region used here: `us-east-1`.

## 0. One-time tools on your Mac

    brew install awscli
    aws configure          # access key of an IAM user with admin rights, region us-east-1, output json

Docker Desktop must be running for step 3.

## 1. S3 bucket (AWS console → S3 → Create bucket)

1. Name: `ciroh-drought-dashboard`, region `us-east-1`.
2. **Uncheck "Block all public access"** (the dashboard must read the files) and confirm.
3. Bucket → Permissions → **Bucket policy** → paste `s3-public-read-policy.json` (with your bucket name).
   This makes only the `nwm_forecasts/` folder readable, and read-only.
4. Bucket → Permissions → **CORS** → paste the content of `s3-cors.json`.
   It allows `https://savalann.github.io` and `http://localhost:8000`; add other addresses if you use them.

## 2. Copy the forecasts you already have (from the project root)

    aws s3 sync 03.output/nwm_forecasts/daily s3://ciroh-drought-dashboard/nwm_forecasts/daily

(~36 MB. Add the `hourly` folder the same way only if you want it in the cloud too.)

## 3. Build and upload the Lambda image (from 01.script/nwm_forecast/)

    aws ecr create-repository --repository-name nwm-forecast-lambda          # first time only
    aws ecr get-login-password | docker login --username AWS --password-stdin 858933856877.dkr.ecr.us-east-1.amazonaws.com
    docker build --platform linux/arm64 --provenance=false -t nwm-forecast-lambda .
    docker tag nwm-forecast-lambda:latest 858933856877.dkr.ecr.us-east-1.amazonaws.com/nwm-forecast-lambda:latest
    docker push 858933856877.dkr.ecr.us-east-1.amazonaws.com/nwm-forecast-lambda:latest

`--provenance=false` is needed: Lambda rejects the extra manifest Docker adds by default.

## 4. Create the Lambda (AWS console → Lambda → Create function)

1. **Container image**, name `nwm-forecast-updater`, image = the one pushed above, architecture **arm64**.
2. Configuration → General: **Memory 3008 MB**, **Timeout 15 min**.
3. Configuration → Environment variables:
   - `NWM_BUCKET` = `ciroh-drought-dashboard`
   - `CIROH_NWM_API_KEY` = your key (or set `NWM_SOURCE` = `google` and skip the key)
   - optional: `NWM_CYCLES` (default `00 06 12 18`), `NWM_KINDS` (default `daily`), `NWM_LOOKBACK_DAYS` (default `3`)
4. Configuration → Permissions → click the role → Add permissions → Create inline policy → JSON →
   paste `lambda-s3-policy.json` (with your bucket name).
5. Configuration → Concurrency → **Reserved concurrency = 1** (two copies at once would pay for the same run twice).

## 5. Test it (Lambda → Test tab)

- Event `{"dry_run": true}` → lists what it would fetch, writes nothing.
- Event `{}` → the real thing. Output shows `saved ... [api]` or `[google]`. A Google run takes ~15-20 s.
- Logs: Monitor → View CloudWatch logs.

## 6. Schedule it (Lambda → Add trigger → EventBridge)

New rule, schedule expression (UTC):

    cron(0 1,7,13,19 * * ? *)

Each cycle (00/06/12/18z) is published ~6.5 h after its time, so each call picks up the newest run.
A missed or failed call is filled in by the next one (it always looks back 3 days).

## 7. Point the dashboard at S3

In `01.script/dashboard/js/config.js`:

    NWM_FORECAST_BASE_URL: "https://ciroh-drought-dashboard.s3.us-east-1.amazonaws.com/nwm_forecasts",

Commit/push → GitHub Pages reads from S3. Check: open
`https://ciroh-drought-dashboard.s3.us-east-1.amazonaws.com/nwm_forecasts/daily/medium_range/00/0/alabama/20261102.parquet`
in a browser; it should download.

## Updating the code later

Rebuild and push (step 3), then:

    aws lambda update-function-code --function-name nwm-forecast-updater \
      --image-uri 858933856877.dkr.ecr.us-east-1.amazonaws.com/nwm-forecast-lambda:latest

## Cost (estimate)

4 calls/day × ~1 min × 3 GB is within the Lambda free tier. S3 storage and requests for
these small files: cents per month. ECR stores the ~0.9 GB image: ~$0.09/month after its free 500 MB.
