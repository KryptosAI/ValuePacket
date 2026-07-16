.PHONY: demo-local demo-anvil demo-local-safe anvil deploy-local

demo-local:
	./scripts/local-demo.sh

demo-anvil: demo-local

anvil:
	anvil --host 0.0.0.0 --port 8545 --chain-id 31337

demo-local-safe:
	@curl -s -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' http://localhost:8545 2>/dev/null | grep -q '31337' && \
		echo "Reusing existing anvil on port 8545" && ./scripts/local-demo.sh || \
		(echo "No anvil found on port 8545. Start one with: make anvil" && exit 1)

deploy-local:
	@echo "Deploying contracts to localhost:8545..."
	@export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 && \
	cd contracts && forge script script/Deploy.s.sol --broadcast --rpc-url http://localhost:8545
