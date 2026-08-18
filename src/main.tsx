import {Component, type ReactNode} from 'react';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { UIProvider } from './context/UIContext';
import './index.css';

class ErrorBoundary extends Component<{children: ReactNode}, {error: Error | null}> {
  state = {error: null as Error | null};

  static getDerivedStateFromError(error: Error) {
    return {error};
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{padding: 24, fontFamily: 'monospace', background: '#0d1117', color: '#f85149', minHeight: '100vh'}}>
          <h1 style={{fontSize: 20, marginBottom: 12}}>Something went wrong</h1>
          <pre style={{whiteSpace: 'pre-wrap', fontSize: 13, color: '#8b949e'}}>
            {this.state.error.message}
          </pre>
          <button
            onClick={() => { this.setState({error: null}); }}
            style={{marginTop: 16, padding: '6px 16px', background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: 6, cursor: 'pointer'}}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <UIProvider>
        <App />
      </UIProvider>
    </ErrorBoundary>
  </StrictMode>,
);
