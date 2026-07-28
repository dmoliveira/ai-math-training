.PHONY: help install dev lint test test-e2e build check

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "; printf "Math Training commands:\n\n"} /^[[:alnum:]_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install locked dependencies
	npm ci

dev: ## Start the Vite development server
	npm run dev

lint: ## Run ESLint
	npm run lint

test: ## Run unit tests
	npm test

test-e2e: ## Run Playwright browser tests
	npm run test:e2e

build: ## Build the production site
	npm run build

check: ## Run lint, unit tests, type-check, and build
	npm run check
