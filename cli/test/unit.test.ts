import { describe, it, expect, vi } from 'vitest';

import { log, formatAddress, formatUsdc, usdcToWei, weiToUsdc, truncate, ZERO_ADDRESS, FAUCET_URLS } from '../src/utils.js';
import {
  serviceRegistryAbi,
  paymentChannelAbi,
  erc20Abi,
  USDC_BASE_SEPOLIA,
} from '../src/contracts.js';
import { SERVICE_DESCRIPTOR } from '../src/demo.js';

describe('Utils', () => {
  it('formatUsdc displays correct values', () => {
    expect(formatUsdc(5000000n)).toBe('$5.00');
    expect(formatUsdc(50000n)).toBe('$0.05');
    expect(formatUsdc(0n)).toBe('$0.00');
    expect(formatUsdc(1234567n)).toBe('$1.234567');
  });

  it('usdcToWei / weiToUsdc round-trip', () => {
    const usdc = 5.00;
    const wei = usdcToWei(usdc);
    expect(wei).toBe(5000000n);
    expect(weiToUsdc(wei)).toBe(5);
  });

  it('formatAddress truncates correctly', () => {
    const addr = '0xabababababababababababababababababababab';
    const formatted = formatAddress(addr);
    expect(formatted).toMatch(/^0xabab.*abab$/);
    expect(formatted.length).toBeLessThan(addr.length);
  });

  it('truncate shortens long strings', () => {
    const long = 'a'.repeat(100);
    expect(truncate(long, 80).length).toBeLessThanOrEqual(80);
    expect(truncate('short')).toBe('short');
  });

  it('ZERO_ADDRESS is correct', () => {
    expect(ZERO_ADDRESS).toBe('0x0000000000000000000000000000000000000000');
  });

  it('log writes formatted output', () => {
    const spy = vi.spyOn(process.stdout, 'write');
    log('test message');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('Contracts', () => {
  it('serviceRegistryAbi has register function', () => {
    const registerFn = serviceRegistryAbi.find(
      (e: any) => e.type === 'function' && e.name === 'register',
    );
    expect(registerFn).toBeDefined();
    expect(registerFn!.inputs).toHaveLength(3);
    expect(registerFn!.outputs[0].name).toBe('serviceId');
  });

  it('scrviceRegistryAbi has getService function', () => {
    const getService = serviceRegistryAbi.find(
      (e: any) => e.type === 'function' && e.name === 'getService',
    );
    expect(getService).toBeDefined();
  });

  it('paymentChannelAbi has openChannel function', () => {
    const openChannel = paymentChannelAbi.find(
      (e: any) => e.type === 'function' && e.name === 'openChannel',
    );
    expect(openChannel).toBeDefined();
    expect(openChannel!.inputs).toHaveLength(6);
  });

  it('paymentChannelAbi has closeChannel function', () => {
    const closeChannel = paymentChannelAbi.find(
      (e: any) => e.type === 'function' && e.name === 'closeChannel',
    );
    expect(closeChannel).toBeDefined();
  });

  it('erc20Abi has approve function', () => {
    const approve = erc20Abi.find(
      (e: any) => e.type === 'function' && e.name === 'approve',
    );
    expect(approve).toBeDefined();
  });

  it('USDC_BASE_SEPOLIA is a valid address', () => {
    expect(USDC_BASE_SEPOLIA).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});

describe('Service Descriptor', () => {
  it('has required fields', () => {
    expect(SERVICE_DESCRIPTOR.protocol).toBe('valuepacket/1.0');
    expect(SERVICE_DESCRIPTOR.service.id).toBe('prediction-feed');
    expect(SERVICE_DESCRIPTOR.service.name).toBeTruthy();
    expect(SERVICE_DESCRIPTOR.pricing.pricePerRequest).toBe('50000');
    expect(SERVICE_DESCRIPTOR.pricing.token).toBe(USDC_BASE_SEPOLIA);
  });
});
