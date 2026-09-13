'use client'

import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps { children: ReactNode }
interface ErrorBoundaryState { error: unknown | null }

/**
 * Catches render-time exceptions in the subtree and shows a self-contained
 * fallback with a retry button, instead of unmounting the entire app.
 * Wrap risky islands: terminal panes, modals, full-page detail views.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('[ui] uncaught render error', error, info)
  }

  private reset = () => this.setState({ error: null })

  render() {
    if (this.state.error !== null) {
      const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
      return (
        <div className="error-boundary-fallback">
          <p><b>Something went wrong in this view.</b></p>
          <small className="mono">{message}</small>
          <button className="secondary-button" onClick={this.reset}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}
