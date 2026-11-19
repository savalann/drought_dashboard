# Container image for lambda_handler.py. Build from 01.script/nwm_forecast/ (see aws/README.md).
FROM public.ecr.aws/lambda/python:3.13
RUN pip install --no-cache-dir "numpy>=2.5" "pandas>=3.0.5" "pyarrow>=25.0.1" "h5py>=3.16.0" "requests>=2.34.2"
COPY download_medium_range.py update_forecasts.py google_source.py lambda_handler.py stations_alabama.json ${LAMBDA_TASK_ROOT}/
CMD ["lambda_handler.handler"]
