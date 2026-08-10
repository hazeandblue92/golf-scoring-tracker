import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportClientError } from '../lib/error-reporting.ts';

interface State {
  incidentId: string | null;
  copied: boolean;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { incidentId: null, copied: false };

  static getDerivedStateFromError(): State {
    return { incidentId: crypto.randomUUID(), copied: false };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    if (this.state.incidentId) void reportClientError('RENDER_BOUNDARY', this.state.incidentId, 'critical');
  }

  async copyIncident() {
    if (!this.state.incidentId) return;
    try {
      await navigator.clipboard.writeText(this.state.incidentId);
      this.setState({ copied: true });
    } catch {
      this.setState({ copied: false });
    }
  }

  override render() {
    if (!this.state.incidentId) return this.props.children;
    return <main className="error-boundary"><div><h1>The scorecard hit an unexpected problem.</h1><p>Your locally saved scoring work remains on this device. Reload the app; if the problem returns, give the incident code to the operator.</p><dl><dt>Incident code</dt><dd><code>{this.state.incidentId}</code></dd></dl><div className="action-row"><button className="button button--primary" type="button" onClick={() => window.location.reload()}>Reload app</button><button className="button button--quiet" type="button" onClick={() => void this.copyIncident()}>{this.state.copied ? 'Copied' : 'Copy incident code'}</button></div></div></main>;
  }
}
