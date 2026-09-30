.PHONY: test test-docker stateful-up stateful-image test-stateful test-stateful-clean test-stateful-stability stateful-down

TEST_IMAGE ?= __SERVICE_NAME__-test:local
STATEFUL_TEST ?=
STATEFUL_REPEAT ?=20

test:
	bash ./scripts/run-tests.sh

test-docker:
	docker build --target test --tag $(TEST_IMAGE) .
	docker run --rm $(TEST_IMAGE)

stateful-up:
	bash ./scripts/run-stateful-tests.sh up

stateful-image:
	bash ./scripts/run-stateful-tests.sh image

test-stateful:
	W_STATEFUL_TEST="$(STATEFUL_TEST)" bash ./scripts/run-stateful-tests.sh test

test-stateful-clean:
	W_STATEFUL_TEST="$(STATEFUL_TEST)" bash ./scripts/run-stateful-tests.sh clean

test-stateful-stability:
	W_STATEFUL_TEST="$(STATEFUL_TEST)" W_STATEFUL_REPEAT="$(STATEFUL_REPEAT)" bash ./scripts/run-stateful-tests.sh stability

stateful-down:
	bash ./scripts/run-stateful-tests.sh down
