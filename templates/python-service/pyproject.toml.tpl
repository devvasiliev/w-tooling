[build-system]
requires = ["setuptools==75.8.2"]
build-backend = "setuptools.build_meta"

[project]
name = "__SERVICE_NAME__"
version = "0.1.0"
description = "W Python service"
readme = "README.md"
requires-python = ">=3.12,<3.13"
dependencies = [
    "fastapi==0.141.1",
    "pydantic==2.13.4",
    "pydantic-settings==2.10.1",
    "starlette==1.6.0",
    "uvicorn==0.35.0",
]

[project.scripts]
__SERVICE_NAME__-api = "__SERVICE_PACKAGE__.bootstrap.api:main"
__SERVICE_NAME__-worker = "__SERVICE_PACKAGE__.bootstrap.worker:main"

[tool.setuptools.packages.find]
where = ["src"]

[tool.ruff]
target-version = "py312"
line-length = 100

[tool.ruff.lint]
select = ["B", "E", "F", "I", "RUF", "UP"]
# Русские комментарии и диагностические сообщения содержат кириллицу намеренно.
ignore = ["RUF001", "RUF002", "RUF003"]

[tool.mypy]
python_version = "3.12"
strict = true
packages = ["__SERVICE_PACKAGE__"]
mypy_path = "src"
