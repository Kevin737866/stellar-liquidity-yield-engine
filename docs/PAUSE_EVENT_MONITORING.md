# Pause Event Monitoring Guide

This guide explains how monitors and dashboards can consume pause events with reason categories to track and alert on vault and rebalance engine pauses.

## Overview

Pause events now include structured reason categories that help monitoring systems understand why a system was paused. This enables:

- **Targeted alerts**: Different alert thresholds for different pause reasons
- **Dashboard filtering**: Group and visualize pauses by cause
- **Automated responses**: Trigger different actions based on pause reason
- **Audit trails**: Maintain detailed records of why pauses occurred

## Pause Reason Categories

| Reason | Description | Typical Use Case |
|--------|-------------|------------------|
| `security` | Security concern detected (exploit, suspicious activity) | Critical alerts, immediate investigation |
| `circuit_breaker` | Circuit breaker triggered (high volatility, large slippage) | High-priority alerts, risk monitoring |
| `slippage_protection` | Price deviation exceeded threshold | Medium-priority alerts, market conditions |
| `maintenance` | Scheduled maintenance or upgrade | Informational, planned downtime |
| `governance` | Governance decision or protocol vote | Informational, protocol changes |
| `liquidity_issue` | Insufficient liquidity in pool | Medium-priority alerts, liquidity monitoring |
| `emergency` | Emergency situation requiring immediate pause | Critical alerts, immediate response |
| `manual` | Manual administrative pause | Informational, admin action |

## Consuming Pause Events

### VaultClient Example

```typescript
import { VaultClient, PauseReason } from '@stellar-liquidity-yield-engine/sdk';

const vaultClient = new VaultClient(vaultAddress, networkConfig);

// Listen for pause events
vaultClient.on('pause', (event) => {
  console.log(`Vault paused at ${new Date(event.timestamp * 1000).toISOString()}`);
  console.log(`Reason: ${event.reason}`);
  console.log(`Details: ${event.reasonDetails || 'No details provided'}`);

  // Take action based on reason
  switch (event.reason) {
    case 'security':
      // Trigger critical alert
      alertSecurityTeam(event);
      break;
    case 'circuit_breaker':
      // Log to risk monitoring system
      logRiskEvent(event);
      break;
    case 'maintenance':
      // Update dashboard with planned downtime
      updateMaintenanceStatus(event);
      break;
    default:
      // Log informational event
      logInfo(event);
  }
});

// Listen for unpause events
vaultClient.on('unpause', (event) => {
  console.log(`Vault unpaused at ${new Date(event.timestamp * 1000).toISOString()}`);
  // Clear alerts, resume monitoring
});

// Listen for all vault events
vaultClient.on('vaultEvent', (event) => {
  // Central event handler for all vault events
  sendToMonitoringDashboard(event);
});
```

### RebalancerClient Example

```typescript
import { RebalancerClient, PauseReason } from '@stellar-liquidity-yield-engine/sdk';

const rebalancerClient = new RebalancerClient(networkConfig);

// Listen for pause events
rebalancerClient.on('pause', (event) => {
  console.log(`Rebalance engine paused at ${new Date(event.timestamp * 1000).toISOString()}`);
  console.log(`Reason: ${event.reason}`);
  console.log(`Details: ${event.reasonDetails || 'No details provided'}`);

  // Route to appropriate monitoring channel
  if (event.reason === 'security' || event.reason === 'emergency') {
    sendToCriticalAlerts(event);
  } else if (event.reason === 'circuit_breaker' || event.reason === 'slippage_protection') {
    sendToRiskMonitoring(event);
  } else {
    sendToOperationalLogs(event);
  }
});

// Listen for unpause events
rebalancerClient.on('unpause', (event) => {
  console.log(`Rebalance engine unpaused at ${new Date(event.timestamp * 1000).toISOString()}`);
  // Resume rebalancing operations
});
```

## Dashboard Integration

### Example: Pause Reason Dashboard

```typescript
// Aggregate pause events by reason for dashboard display
const pauseStats = {
  security: 0,
  circuit_breaker: 0,
  slippage_protection: 0,
  maintenance: 0,
  governance: 0,
  liquidity_issue: 0,
  emergency: 0,
  manual: 0
};

vaultClient.on('pause', (event) => {
  if (event.reason) {
    pauseStats[event.reason]++;
    updateDashboardCharts(pauseStats);
  }
});

// Display pause events in a timeline
const pauseTimeline: Array<{
  timestamp: number;
  reason: PauseReason;
  details?: string;
}> = [];

vaultClient.on('pause', (event) => {
  pauseTimeline.push({
    timestamp: event.timestamp,
    reason: event.reason!,
    details: event.reasonDetails
  });
  renderTimeline(pauseTimeline);
});
```

### Example: Alert Routing

```typescript
interface AlertConfig {
  reason: PauseReason;
  severity: 'critical' | 'high' | 'medium' | 'low';
  channels: string[];
  autoResponse?: () => void;
}

const alertConfigs: AlertConfig[] = [
  {
    reason: 'security',
    severity: 'critical',
    channels: ['pagerduty', 'slack-security', 'email-oncall'],
    autoResponse: () => emergencyShutdown()
  },
  {
    reason: 'emergency',
    severity: 'critical',
    channels: ['pagerduty', 'slack-ops', 'email-oncall'],
    autoResponse: () => initiateEmergencyProtocol()
  },
  {
    reason: 'circuit_breaker',
    severity: 'high',
    channels: ['slack-risk', 'email-risk-team']
  },
  {
    reason: 'slippage_protection',
    severity: 'medium',
    channels: ['slack-ops']
  },
  {
    reason: 'liquidity_issue',
    severity: 'medium',
    channels: ['slack-ops', 'email-liquidity-team']
  },
  {
    reason: 'maintenance',
    severity: 'low',
    channels: ['slack-ops']
  },
  {
    reason: 'governance',
    severity: 'low',
    channels: ['slack-governance']
  },
  {
    reason: 'manual',
    severity: 'low',
    channels: ['slack-ops']
  }
];

function handlePauseEvent(event: { reason?: PauseReason; reasonDetails?: string }) {
  if (!event.reason) return;

  const config = alertConfigs.find(c => c.reason === event.reason);
  if (config) {
    sendAlert({
      severity: config.severity,
      channels: config.channels,
      message: `Pause event: ${event.reason} - ${event.reasonDetails || 'No details'}`,
      timestamp: Date.now()
    });

    if (config.autoResponse) {
      config.autoResponse();
    }
  }
}
```

## Monitoring Best Practices

1. **Separate alert channels**: Route different pause reasons to appropriate teams
   - Security/emergency → On-call team
   - Circuit breaker/slippage → Risk team
   - Maintenance → Operations team
   - Governance → Protocol team

2. **Set appropriate thresholds**: Not all pauses require immediate action
   - Critical: security, emergency
   - High: circuit_breaker
   - Medium: slippage_protection, liquidity_issue
   - Low: maintenance, governance, manual

3. **Track pause frequency**: Monitor for repeated pauses of the same type
   - Frequent circuit_breaker pauses may indicate market instability
   - Repeated security pauses may require protocol review

4. **Correlate with other metrics**: Combine pause events with
   - TVL changes
   - APY fluctuations
   - Gas price spikes
   - Network congestion

5. **Maintain audit trail**: Store all pause events with reasons for
   - Regulatory compliance
   - Post-incident analysis
   - Protocol governance

## Event Schema

### VaultEvent

```typescript
interface VaultEvent {
  type: 'deposit' | 'withdraw' | 'harvest' | 'pause' | 'unpause';
  vault: Address;
  user?: Address;
  amount?: bigint;
  timestamp: number; // Unix timestamp in seconds
  data?: any;
  reason?: PauseReason; // Only present for pause/unpause events
  reasonDetails?: string; // Additional context about the pause reason
}
```

### RebalanceEvent

```typescript
interface RebalanceEvent {
  type: 'proposal' | 'execution' | 'failure' | 'pause' | 'unpause';
  strategy: number;
  fromPool?: Address;
  toPool?: Address;
  amount?: bigint;
  timestamp: number; // Unix timestamp in seconds
  data?: any;
  reason?: PauseReason; // Only present for pause/unpause events
  reasonDetails?: string; // Additional context about the pause reason
}
```

## Testing Event Consumption

See `sdk/src/pauseEvents.test.ts` for comprehensive tests covering:
- All pause reason categories
- Event emission with and without details
- Both VaultClient and RebalancerClient
- Event listener registration
- Type validation

Run tests with:
```bash
npm test -- pauseEvents.test.ts
```
