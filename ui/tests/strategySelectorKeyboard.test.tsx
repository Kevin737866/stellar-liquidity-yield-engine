import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { YieldStrategy } from '../../sdk/src/index';

const strategies = [
  {
    strategyId: 1,
    name: 'Conservative Vault',
    description: 'Low volatility stable pools',
    riskLevel: 1,
    minInvestment: 1000000n,
    feeStructure: { managementFee: 500 },
    performanceHistory: [
      { netApy: 520, volatility: 120, sharpeRatio: 11000, totalValue: 5000000n },
    ],
  },
  {
    strategyId: 2,
    name: 'Balanced Vault',
    description: 'Mixed XLM and stable pools',
    riskLevel: 2,
    minInvestment: 2500000n,
    feeStructure: { managementFee: 750 },
    performanceHistory: [
      { netApy: 840, volatility: 310, sharpeRatio: 9000, totalValue: 8000000n },
    ],
  },
];

// `StrategySelector` imports the SDK through the `tsconfig.json` path alias,
// which Next's Jest transform rewrites to this module id.
jest.mock('../../sdk/src/index', () => ({
  StrategyRegistryClient: class {
    async fetchActiveStrategies() {
      return strategies;
    }
  },
}));

import { StrategySelector } from '@/components/StrategySelector';

function ControlledSelector({ onStrategySelect }: { onStrategySelect: (s: YieldStrategy) => void }) {
  const [selected, setSelected] = useState<YieldStrategy | null>(null);
  return (
    <StrategySelector
      selectedStrategy={selected}
      onStrategySelect={(strategy) => {
        setSelected(strategy);
        onStrategySelect(strategy);
      }}
    />
  );
}

describe('strategy selection keyboard navigation', () => {
  it('selects a strategy with arrow keys and reports it', async () => {
    const user = userEvent.setup();
    const onStrategySelect = jest.fn();

    render(<ControlledSelector onStrategySelect={onStrategySelect} />);

    const conservative = await screen.findByRole('radio', { name: /conservative vault/i });
    const balanced = screen.getByRole('radio', { name: /balanced vault/i });

    conservative.focus();
    await user.keyboard('{ArrowDown}');

    expect(balanced).toHaveFocus();
    expect(balanced).toHaveAttribute('aria-checked', 'true');
    expect(onStrategySelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ strategyId: 2 }),
    );

    await waitFor(() => {
      expect(screen.getByText(/selected strategy summary/i)).toBeInTheDocument();
    });
    // Once in the strategy card, once in the selected-strategy summary.
    expect(screen.getAllByText('Balanced Vault')).toHaveLength(2);
  });
});
