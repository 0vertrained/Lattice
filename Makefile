.PHONY: check test fmt lint frontend frontend-test compose security

check:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets --all-features -- -D warnings
	cargo test --workspace
	cd apps/control-center && npm run check && npm run build
	python3 -m compileall services/lattice-ai-gateway/app

test:
	cargo test --workspace
	cd apps/control-center && npm test

fmt:
	cargo fmt --all
	cd apps/control-center && npm run format

lint:
	cargo clippy --workspace --all-targets --all-features -- -D warnings
	cd apps/control-center && npm run lint

frontend:
	cd apps/control-center && npm run dev

frontend-test:
	cd apps/control-center && npm test

compose:
	docker compose up --build

security:
	cargo audit
	cargo deny check
