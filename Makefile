.PHONY: demo-local demo-anvil anvil deploy-local

demo-local:
	./scripts/local-demo.sh

demo-anvil: demo-local

anvil:
	@lsof -ti tcp:8545 | xargs kill -9 2>/dev/null || true
	anvil --host 0.0.0.0 --port 8545 --chain-id 31337

deploy-local:
	@echo "Deploying contracts to localhost:8545..."
	@export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 && \
	cd contracts && forge script script/Deploy.s.sol --broadcast --rpc-url http://localhost:8545
