import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Panel-level error boundary.
 *
 * A dashboard whose panels each depend on a different upstream feed will, at
 * some point, hand one of those panels a shape it did not expect — a rate
 * limit, a provider outage, a field that went null. Without a boundary, that
 * single panel throwing unmounts the whole tree and the user gets a blank
 * page, which is both the least informative failure mode and the one that
 * looks most like "the app is broken" when in fact one feed is degraded.
 *
 * Wrapping each panel keeps a failure local and, crucially, keeps it *visible*
 * and named rather than silent.
 */
interface Props {
  children: ReactNode;
  /** Shown in the fallback so the user knows which panel failed. */
  label: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}] panel crashed:`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="missing">
        <div className="reason-tag">Panel failed to render — {this.props.label}</div>
        <div className="why">{error.message}</div>
        <div className="why">
          The rest of the dashboard is unaffected. This is a bug in the panel,
          not a statement about the fund; no data is being shown for it.
        </div>
        <button
          className="tf-btn"
          style={{ marginTop: 8 }}
          onClick={() => this.setState({ error: null })}
        >
          retry
        </button>
      </div>
    );
  }
}
