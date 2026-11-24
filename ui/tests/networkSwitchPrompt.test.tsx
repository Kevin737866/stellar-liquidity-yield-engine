import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkSwitchPrompt } from '@/components/NetworkSwitchPrompt';

const defaultProps = {
  open: true,
  actionLabel: 'deposit',
  onCancel: jest.fn(),
  onConfirm: jest.fn(),
};

describe('NetworkSwitchPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('explains the mainnet action and shows the signer passphrase', () => {
    render(<NetworkSwitchPrompt {...defaultProps} />);

    expect(
      screen.getByRole('dialog', { name: /switch to mainnet to continue/i })
    ).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText(/about to deposit on/i)).toBeInTheDocument();
    expect(screen.getByTestId('mainnet-passphrase')).toHaveTextContent(
      'Public Global Stellar Network ; September 2015'
    );
  });

  it('focuses Cancel so the safe choice is the default', () => {
    render(<NetworkSwitchPrompt {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('cancels on Cancel, Escape, and backdrop clicks without confirming', async () => {
    const user = userEvent.setup();
    render(<NetworkSwitchPrompt {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(2);

    fireEvent.mouseDown(screen.getByTestId('network-switch-overlay'));
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(3);
    expect(defaultProps.onConfirm).not.toHaveBeenCalled();
  });

  it('confirms the switch when the user accepts', async () => {
    const user = userEvent.setup();
    render(<NetworkSwitchPrompt {...defaultProps} />);

    await user.click(screen.getByTestId('confirm-network-switch'));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables confirmation while switching and reports switch errors', () => {
    render(
      <NetworkSwitchPrompt
        {...defaultProps}
        switching
        error="Freighter rejected the network switch"
      />
    );

    expect(screen.getByTestId('confirm-network-switch')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Freighter rejected the network switch');
  });

  it('renders nothing when closed', () => {
    render(<NetworkSwitchPrompt {...defaultProps} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
