import {
  GovernanceSDK,
  GOVERNANCE_PARAMETER_BOUNDS,
  type ProtocolParameters,
} from './governance';

const GOVERNANCE_CONTRACT = 'CGOVERNANCECONTRACT';

function sdkWithParameters(
  parameters: Partial<ProtocolParameters> = {},
): GovernanceSDK {
  const sdk = new GovernanceSDK(
    'https://127.0.0.1:8080',
    'Test SDF Network ; September 2015',
    undefined,
    { governance: GOVERNANCE_CONTRACT },
  );

  jest.spyOn(sdk, 'getProtocolParameters').mockResolvedValue({
    performanceFee: 1000,
    withdrawalFee: 10,
    rebalanceThreshold: 200,
    insuranceReserveTarget: 15000,
    ...parameters,
  });

  return sdk;
}

describe('GovernanceSDK.previewParameterChange', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports the affected parameter values and the call it would make', async () => {
    const sdk = sdkWithParameters();

    const preview = await sdk.previewParameterChange('performance_fee', 1200);

    expect(preview).toMatchObject({
      action: 'set_protocol_parameter',
      parameter: 'performance_fee',
      currentValue: 1000,
      proposedValue: 1200,
      delta: 200,
      percentChange: 20,
      changed: true,
      inBounds: true,
      errors: [],
      warnings: [],
      description: 'Change performance_fee to 1200',
      currentFormatted: '10.00%',
      proposedFormatted: '12.00%',
      deltaFormatted: '+2.00%',
    });
    expect(preview.callData).toEqual([
      {
        contractAddress: GOVERNANCE_CONTRACT,
        functionName: 'set_performance_fee',
        args: [1200],
      },
    ]);
  });

  it('maps each governable parameter to its own live value and setter', async () => {
    const sdk = sdkWithParameters();

    const withdrawal = await sdk.previewParameterChange('withdrawal_fee', 50);
    const threshold = await sdk.previewParameterChange('rebalance_threshold', 300);
    const reserve = await sdk.previewParameterChange('insurance_reserve_target', 12000);

    expect([withdrawal.currentValue, threshold.currentValue, reserve.currentValue]).toEqual([
      10, 200, 15000,
    ]);
    expect(withdrawal.callData[0].functionName).toBe('set_withdrawal_fee');
    expect(threshold.callData[0].functionName).toBe('set_rebalance_threshold');
    expect(reserve.callData[0].functionName).toBe('set_insurance_reserve_target');
    expect(reserve.delta).toBe(-3000);
    expect(reserve.deltaFormatted).toBe('-30.00%');
  });

  it('rejects values outside the on-chain range without throwing', async () => {
    const sdk = sdkWithParameters();

    const tooLow = await sdk.previewParameterChange('performance_fee', 400);
    const tooHigh = await sdk.previewParameterChange('withdrawal_fee', 500);

    expect(tooLow.inBounds).toBe(false);
    expect(tooLow.errors[0]).toMatch(/between 5\.00% and 15\.00%/);
    expect(tooLow.changed).toBe(true);

    expect(tooHigh.inBounds).toBe(false);
    expect(tooHigh.errors[0]).toMatch(/between 0\.10% and 1\.00%/);
  });

  it('rejects non-integer values', async () => {
    const sdk = sdkWithParameters();

    const preview = await sdk.previewParameterChange('rebalance_threshold', 2.5);

    expect(preview.inBounds).toBe(false);
    expect(preview.errors[0]).toMatch(/whole number/);
  });

  it('warns when the proposal would be a no-op', async () => {
    const sdk = sdkWithParameters();

    const preview = await sdk.previewParameterChange('performance_fee', 1000);

    expect(preview.changed).toBe(false);
    expect(preview.errors).toEqual([]);
    expect(preview.warnings[0]).toMatch(/already 10\.00%/);
  });

  it('accepts both ends of every configured range', async () => {
    const sdk = sdkWithParameters();

    for (const [parameter, bounds] of Object.entries(GOVERNANCE_PARAMETER_BOUNDS)) {
      const low = await sdk.previewParameterChange(parameter as never, bounds.min);
      const high = await sdk.previewParameterChange(parameter as never, bounds.max);

      expect(low.errors).toEqual([]);
      expect(high.errors).toEqual([]);
      expect(low.inBounds).toBe(true);
      expect(high.inBounds).toBe(true);
    }
  });

  it('rejects an unknown parameter', async () => {
    const sdk = sdkWithParameters();

    await expect(
      (sdk as any).previewParameterChange('quorum_percentage', 500),
    ).rejects.toThrow(/Unknown protocol parameter/);
  });

  it('propagates a failed on-chain read', async () => {
    const sdk = sdkWithParameters();
    jest.spyOn(sdk, 'getProtocolParameters').mockRejectedValue(new Error('rpc down'));

    await expect(sdk.previewParameterChange('performance_fee', 1200)).rejects.toThrow(
      'rpc down',
    );
  });
});
