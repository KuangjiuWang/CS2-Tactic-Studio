import {
  Activity, ArrowRight, ArrowUpRight, Bomb, Camera, Circle, Cloud,
  Eraser, Flame, FolderOpen, Grid2X2, MousePointer2, Pen, Plus,
  Redo2, Route, Save, Settings, Square, Target, Trash2, Type, Undo2, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useStore } from './store';
import { newTactic } from '../tactics/model';
import type { MapOverview } from '../types';
import { useTranslation } from 'react-i18next';

const drawingTools: [string, LucideIcon, string][] = [
  ['pointer', MousePointer2, 'select'],
  ['pen', Pen, 'draw'],
  ['eraser', Eraser, 'deleteObject'],
  ['rectangle', Square, 'rectangle'],
  ['circle', Circle, 'circle'],
  ['text', Type, 'text'],
  ['line', ArrowRight, 'line'],
  ['arrow', ArrowUpRight, 'arrow'],
];
const utilityTools: [string, LucideIcon, string][] = [
  ['smoke', Cloud, 'smoke'],
  ['flash', Zap, 'flash'],
  ['he', Target, 'he'],
  ['molotov', Flame, 'molotov'],
  ['decoy', Activity, 'decoy'],
];

function ToolButton({ icon: Icon, label, active = false, disabled = false, onClick }: {
  icon: LucideIcon; label: string; active?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <button className={`icon-button ${active ? 'active' : ''}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon size={16} /></button>;
}

export function TacticalToolbar({ onSave, onOpen, onSettings }: {
  onSave: () => void; onOpen: () => void; onSettings: () => void;
}) {
  const { t } = useTranslation();
  const tool = useStore(s => s.tool);
  const color = useStore(s => s.color);
  const history = useStore(s => s.history);
  const future = useStore(s => s.future);
  const project = useStore(s => s.project);
  const activeStep = useStore(s => s.activeStep);
  const activeTactic = useStore(s => s.activeTactic);
  const steps = project.tactics[activeTactic]?.steps ?? [];
  const pickTool = (value: string) => useStore.getState().set({ tool: value, playing: false });
  const clear = () => {
    const state = useStore.getState();
    if (!state.project.tactics[state.activeTactic].steps[state.activeStep].annotations.length) return;
    if (window.confirm(t('tactics.clearConfirm', { number: state.activeStep + 1 }))) {
      state.editStep(step => ({ ...step, annotations: [] }));
    }
  };
  return <div className="toolbar-scroll"><div className="drawing-toolbar" role="toolbar" aria-label={t('tactics.tools')}>
    {drawingTools.map(([key, icon, label]) => <ToolButton key={key} icon={icon} label={t(`tactics.${label}`)} active={tool === key} onClick={() => pickTool(key)} />)}
    <i />
    {utilityTools.map(([key, icon, label]) => <ToolButton key={key} icon={icon} label={t(`tactics.${label}`)} active={tool === key} onClick={() => pickTool(key)} />)}
    <i />
    <button className={`swatch ${color === '#79c5ff' ? 'chosen' : ''}`} style={{ background: '#79c5ff' }} aria-label={t('tactics.ctBlue')} title={t('tactics.ctBlue')} onClick={() => useStore.getState().set({ color: '#79c5ff' })} />
    <button className={`swatch ${color === '#f5bf55' ? 'chosen' : ''}`} style={{ background: '#f5bf55' }} aria-label={t('tactics.tYellow')} title={t('tactics.tYellow')} onClick={() => useStore.getState().set({ color: '#f5bf55' })} />
    <ToolButton icon={Bomb} label={t('tactics.c4')} active={tool === 'c4'} onClick={() => pickTool('c4')} />
    <i />
    <div className="toolbar-steps" aria-label={t('library.steps')}>{steps.map((step, index) => <button key={index} aria-label={t('tactics.step', { number: index + 1 })} title={`${t('tactics.step', { number: index + 1 })}${step.captured ? t('tactics.captured') : ''}`} className={activeStep === index ? 'active' : ''} onClick={() => useStore.getState().changeStep(index)}>{index + 1}{step.captured && <span />}</button>)}</div>
    <ToolButton icon={Camera} label={t('tactics.captureStep')} onClick={() => useStore.getState().capture()} />
    <ToolButton icon={Trash2} label={t('tactics.clearStep')} onClick={clear} />
    <i />
    <ToolButton icon={Undo2} label={t('tactics.undo')} disabled={!history.length} onClick={() => useStore.getState().undo()} />
    <ToolButton icon={Redo2} label={t('tactics.redo')} disabled={!future.length} onClick={() => useStore.getState().redo()} />
    <ToolButton icon={Save} label={t('app.saveProject')} onClick={onSave} />
    <ToolButton icon={FolderOpen} label={t('app.openProject')} onClick={onOpen} />
    <ToolButton icon={Settings} label={t('app.settings')} onClick={onSettings} />
  </div></div>;
}

export function TacticHeader({ map }: { map: MapOverview | undefined }) {
  const { t } = useTranslation();
  const project = useStore(s => s.project);
  const activeTactic = useStore(s => s.activeTactic);
  const floor = useStore(s => s.floor);
  const paths = useStore(s => s.showPaths);
  const from = useStore(s => s.pathFrom);
  const to = useStore(s => s.pathTo);
  const editing = useStore(s => s.editing);
  const tactic = project.tactics[activeTactic];
  return <div className="map-topline">
    <span className="map-legend"><span className="legend t" /> T <span className="legend ct" /> CT</span>
    <select aria-label={t('tactics.tactic')} value={activeTactic} onChange={e => useStore.getState().set({ activeTactic: +e.target.value, activeStep: 0, editing: false, history: [], future: [] })}>{project.tactics.map((item, index) => <option value={index} key={item.id}>{item.name}</option>)}</select>
    <input aria-label={t('tactics.tacticName')} value={tactic.name} onChange={e => useStore.getState().patchProject({ tactics: project.tactics.map((item, index) => index === activeTactic ? { ...item, name: e.target.value } : item) })} />
    <button aria-label={t('tactics.newTactic')} title={t('tactics.newTactic')} onClick={() => { const state = useStore.getState(); const next = newTactic(state.match.map, state.project.selectedTeam, state.project.demoPath); state.patchProject({ tactics: [...state.project.tactics, next] }); state.set({ activeTactic: state.project.tactics.length, activeStep: 0, editing: false, history: [], future: [] }); }}><Plus size={15} /></button>
    <button className={`path-toggle ${paths ? 'active' : ''}`} onClick={() => useStore.getState().set({ showPaths: !paths })}><Route size={14} /> {t('tactics.paths')}</button>
    {paths && <><select aria-label={t('tactics.pathFrom')} value={from} onChange={e => useStore.getState().set({ pathFrom: +e.target.value })}>{[0, 1, 2, 3].map(i => <option key={i} value={i}>{t('tactics.step', { number: i + 1 })}</option>)}</select><span>→</span><select aria-label={t('tactics.pathTo')} value={to} onChange={e => useStore.getState().set({ pathTo: +e.target.value })}>{[0, 1, 2, 3].map(i => <option key={i} value={i}>{t('tactics.step', { number: i + 1 })}</option>)}</select></>}
    <span className="map-top-spacer" />
    {editing && <button className="return-live" onClick={() => useStore.getState().set({ editing: false })}>{t('tactics.returnLive')}</button>}
    <span className="step-state">{editing ? t('tactics.editing') : t('tactics.live')}</span>
    {map?.sections && <select aria-label={t('tactics.floor')} value={floor} onChange={e => useStore.getState().set({ floor: +e.target.value })}>{map.sections.map((section, index) => <option key={section.name} value={index}>{section.name}</option>)}</select>}
    <Grid2X2 size={14} className="map-top-icon" />
  </div>;
}
