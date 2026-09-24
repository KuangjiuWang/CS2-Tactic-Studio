import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import i18n from './i18n';
import './style.css';
import './fidelity.css';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string}>{state={error:''};static getDerivedStateFromError(e:Error){return {error:e.message};}render(){return this.state.error?<div className="fatal"><h1>{i18n.t('app.loadFailed')}</h1><p>{this.state.error}</p><button onClick={()=>location.reload()}>{i18n.t('app.reload')}</button></div>:this.props.children;}}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
