import { useState } from 'react';
import type { BuildDiagnostic, Scene } from '../shared/types';
import { editValue, type NodeDescription, type Parameter, type ProgramFeedback, type PropertyEdit, type Value } from '../sdk';
import { withValue } from './program-edit';

function TrackEditor({ name, label, value, track, descriptor, frame, duration, disabled, onChange, onSeek }: {
  name: string; label?: string; value: Value; track?: PropertyEdit; descriptor?: Parameter; frame: number; duration: number; disabled?: boolean;
  onChange(track?: PropertyEdit): void; onSeek(frame: number): void;
}) {
  const current = track ? editValue(track, frame) : value;
  const key = track?.keyframes?.find(item => item.frame === frame);
  const locked = disabled || track?.locked;
  function update(next: Value) { if (typeof next !== 'number' || Number.isFinite(next)) onChange(withValue(track, next, frame)); }
  return <div className="program-property">
    <div className="program-property-heading"><label title={name}>{label || name}</label><button aria-label={`锁定 ${name}`} title="保护此属性，AI 无法修改关联代码" onClick={() => onChange({ value: current, ...track, locked: !track?.locked })} disabled={disabled}>{track?.locked ? '🔒' : '锁'}</button>
      <button aria-label={`关键帧 ${name}`} className={key ? 'active' : ''} disabled={locked || descriptor?.animatable === false} title={`在局部帧 ${frame} 添加或移除关键帧`} onClick={() => onChange(key ? { ...track!, keyframes: track!.keyframes!.filter(item => item.frame !== frame) } : withValue(track, current, frame, true))}>◆</button>
      <button aria-label={`重置 ${name}`} disabled={!track || locked} onClick={() => onChange(undefined)} title="恢复代码生成值">↺</button></div>
    {descriptor?.type === 'enum' ? <select aria-label={name} value={String(current)} disabled={locked} onChange={event => update(event.target.value)}>{descriptor.options?.map(option => <option key={option}>{option}</option>)}</select> :
      <input aria-label={name} disabled={locked} type={typeof current === 'boolean' ? 'checkbox' : descriptor?.type === 'color' ? 'color' : typeof current === 'number' ? 'number' : 'text'} value={typeof current === 'boolean' ? undefined : current} checked={typeof current === 'boolean' ? current : undefined} min={descriptor?.min} max={descriptor?.max} step={descriptor?.step || 'any'} onChange={event => update(typeof current === 'boolean' ? event.target.checked : typeof current === 'number' ? Number(event.target.value) : event.target.value)} />}
    {!!track?.keyframes?.length && <details className="program-keys"><summary>{track.keyframes.length} 个关键帧 · {frame} 帧</summary>{track.keyframes.map(item => <div className="program-key" key={item.frame}>
      <button title="跳转到关键帧" onClick={() => onSeek(item.frame)}>▶</button><input aria-label={`${name} 关键帧时间 ${item.frame}`} type="number" min="0" max={duration - 1} value={item.frame} disabled={locked} onChange={event => {
        const next = Number(event.target.value);
        if (!Number.isInteger(next) || next < 0 || next >= duration || track.keyframes!.some(other => other !== item && other.frame === next)) return;
        onChange({ ...track, keyframes: track.keyframes!.map(other => other === item ? { ...other, frame: next } : other).sort((a, b) => a.frame - b.frame) });
      }} /><span title={String(item.value)}>{String(item.value)}</span><select aria-label={`${name} 关键帧插值 ${item.frame}`} disabled={locked} value={item.easing || 'linear'} onChange={event => onChange({ ...track, keyframes: track.keyframes!.map(other => other === item ? { ...other, easing: event.target.value as 'linear' | 'smooth' | 'hold' } : other) })}><option value="linear">线性</option><option value="smooth">平滑</option><option value="hold">保持</option></select>
      <button disabled={locked} aria-label={`${name} 删除关键帧 ${item.frame}`} onClick={() => onChange({ ...track, keyframes: track.keyframes!.filter(other => other !== item) })}>×</button></div>)}</details>}
  </div>;
}

export function ProgramInspector({ scene, sources, diagnostics, feedback, selectedId, frame, onSelect, onSeek, onChange, onEdit, onReset }: {
  scene: Scene; sources: string[]; diagnostics: BuildDiagnostic[];
  feedback?: ProgramFeedback; selectedId?: string; frame: number; onSelect(id?: string): void; onSeek(frame: number): void;
  onChange: (program: NonNullable<Scene['program']>) => void; onEdit: (path: string) => void; onReset: () => void;
}) {
  const program = scene.program!;
  const [expanded, setExpanded] = useState(new Set(['heading', 'title-card']));
  const edits = program.edits || {};
  const nodes = feedback?.nodes || [], selected = nodes.find(node => node.id === selectedId);
  const map = new Map(nodes.map(node => [node.id, node]));
  function depth(node: NodeDescription): number { return node.parentId ? 1 + depth(map.get(node.parentId)!) : 0; }
  function shown(node: NodeDescription): boolean { return !node.parentId || (expanded.has(node.parentId) && shown(map.get(node.parentId)!)); }
  function changeObject(name: string, track?: PropertyEdit) {
    if (!selected) return;
    const object = edits.objects?.[selected.id] || { type: selected.type, properties: {} };
    const properties = { ...object.properties };
    if (track) properties[name] = track; else delete properties[name];
    onChange({ ...program, edits: { ...edits, objects: { ...edits.objects, [selected.id]: { ...object, properties } } } });
  }
  function changeParameter(name: string, track?: PropertyEdit, instanceId?: string) {
    const parameters = { ...(instanceId ? edits.instances?.[instanceId]?.parameters : edits.parameters) };
    if (track) parameters[name] = track; else delete parameters[name];
    onChange({ ...program, edits: instanceId ? { ...edits, instances: { ...edits.instances, [instanceId]: { parameters } } } : { ...edits, parameters } });
  }
  const parameterNames = Object.keys({ ...program.params, ...feedback?.parameters, ...edits.parameters });
  return <div className="inspector-scroll program-inspector">
    <section><h3>程序场景 · 对象编辑</h3><p>人工覆盖按对象 ID 保存；代码更新后继续生效。</p>
      <label className="stacked">入口模块<select aria-label="程序场景入口" value={program.entry} onChange={event => onChange({ ...program, entry: event.target.value })}>{sources.filter(path => path.startsWith('scripts/')).map(path => <option key={path}>{path}</option>)}</select></label>
      <label className="property-row"><span>渲染器</span><select value={program.renderer} onChange={event => onChange({ ...program, renderer: event.target.value as '2d' | 'webgl2' })}><option value="2d">Canvas 2D</option><option value="webgl2">WebGL2</option></select></label>
      <label className="property-row"><span>随机种子</span><input aria-label="程序场景种子" type="number" min="0" max="4294967295" step="1" value={program.seed} onChange={event => { const seed = Number(event.target.value); if (Number.isInteger(seed) && seed >= 0 && seed <= 4294967295) onChange({ ...program, seed }); }} /></label>
      <button onClick={() => onEdit(program.entry)}>编辑入口代码</button> <button onClick={onReset}>重建预览实例</button>
    </section>
    <section><h3>场景参数 · 局部 {frame} 帧</h3>{parameterNames.map(name => <TrackEditor key={name} name={`场景参数 ${name}`} label={feedback?.parameters[name]?.label || name} value={feedback?.values[name] ?? program.params?.[name] ?? feedback?.parameters[name]?.default ?? ''} descriptor={feedback?.parameters[name]} track={edits.parameters?.[name]} frame={frame} duration={scene.durationFrames} onChange={track => changeParameter(name, track)} onSeek={onSeek} />)}<small>◆ 设置关键帧；有动画轨道时，修改值会记录到当前帧。</small></section>
    <section><h3>程序对象 <small>{nodes.length}</small></h3><div className="program-object-tree" role="tree" aria-label="程序对象树">{nodes.filter(shown).map(node => <div role="treeitem" aria-selected={selectedId === node.id} className={`program-object ${selectedId === node.id ? 'selected' : ''}`} key={node.id} style={{ paddingLeft: depth(node) * 14 }}>
      {node.type === 'group' ? <button aria-label={`展开 ${node.id}`} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>{expanded.has(node.id) ? '▾' : '▸'}</button> : <span>·</span>}
      <button data-program-object={node.id} onClick={() => onSelect(node.id)} title={node.id}>{node.id}{node.locked ? ' 🔒' : ''}<small>{node.component ? '组件' : node.type}</small></button></div>)}</div>{!feedback && <small>等待当前帧渲染，编译出错时仍可编辑源代码和覆盖记录。</small>}</section>
    {selected && <section className="program-object-inspector"><h3>{selected.id}</h3><button aria-label="锁定程序对象" onClick={() => onChange({ ...program, edits: { ...edits, objects: { ...edits.objects, [selected.id]: { type: selected.type, properties: {}, ...edits.objects?.[selected.id], locked: !edits.objects?.[selected.id]?.locked } } } })}>{edits.objects?.[selected.id]?.locked ? '解锁对象' : '锁定对象'}</button>
      <p>位置默认记录相对代码的偏移。缩放、旋转也可在画布中拖动。</p>{Object.entries(selected.properties).map(([name, value]) => {
        const track = edits.objects?.[selected.id]?.properties[name];
        const offset = (track?.mode || (['x', 'y', 'rotation'].includes(name) ? 'offset' : 'replace')) === 'offset';
        return <div key={name}>{typeof value === 'number' && <select aria-label={`覆盖方式 ${name}`} value={track?.mode || (['x', 'y', 'rotation'].includes(name) ? 'offset' : 'replace')} disabled={selected.locked || track?.locked || !!track?.keyframes?.length} title={track?.keyframes?.length ? '动画轨道需先重置，才能切换覆盖方式' : '切换方式保留当前画面值'} onChange={event => changeObject(name, { ...track, value: event.target.value === 'offset' ? value - Number(selected.codeProperties?.[name] ?? value) : value, mode: event.target.value as 'offset' | 'replace' })}><option value="replace">绝对值</option><option value="offset">相对偏移</option></select>}
          <TrackEditor name={`对象属性 ${name}`} label={name + (offset ? ' · 偏移' : '')} value={offset ? 0 : value} track={track} disabled={selected.locked} frame={frame} duration={scene.durationFrames} onSeek={onSeek} onChange={next => changeObject(name, next ? { mode: ['x', 'y', 'rotation'].includes(name) ? 'offset' : 'replace', ...track, ...next } : undefined)} /></div>;
      })}
      {selected.component && <><h3>组件实例参数</h3>{Object.entries(selected.component.parameters).map(([name, descriptor]) => <TrackEditor key={name} name={`实例参数 ${selected.id}/${name}`} label={descriptor.label || name} descriptor={descriptor} value={selected.component!.values[name]} track={edits.instances?.[selected.id]?.parameters[name]} disabled={selected.locked} frame={frame} duration={scene.durationFrames} onSeek={onSeek} onChange={track => changeParameter(name, track, selected.id)} />)}</>}
    </section>}
    {selectedId && !selected && <section><p className="expression-error">当前帧中没有对象 {selectedId}，其覆盖仍保留。</p></section>}
    {!!feedback?.diagnostics.length && <section><h3>覆盖绑定提示</h3>{feedback.diagnostics.map((item, index) => <p className="expression-error" key={index}>{item.target}：{item.message}</p>)}</section>}
    {!!Object.keys(edits.objects || {}).length && <section><h3>人工覆盖记录</h3>{Object.entries(edits.objects || {}).map(([id, object]) => {
      const protectedRecord = object.locked || Object.values(object.properties).some(track => track.locked) || nodes.find(node => node.id === id)?.locked;
      return <div key={id}><div className="program-override-record"><button onClick={() => onSelect(id)}>{id}</button><button aria-label={`解除覆盖锁 ${id}`} disabled={!protectedRecord} onClick={() => onChange({ ...program, edits: { ...edits, objects: { ...edits.objects, [id]: { ...object, locked: false, properties: Object.fromEntries(Object.entries(object.properties).map(([name, track]) => [name, { ...track, locked: false }])) } } } })}>解锁</button><button aria-label={`清除对象覆盖 ${id}`} disabled={protectedRecord} onClick={() => { const objects = { ...edits.objects }; delete objects[id]; onChange({ ...program, edits: { ...edits, objects } }); }}>清除</button></div>
      <select aria-label={`重新绑定对象 ${id}`} value="" disabled={protectedRecord} onChange={event => { if (!event.target.value) return; const objects = { ...edits.objects }; delete objects[id]; objects[event.target.value] = object; onChange({ ...program, edits: { ...edits, objects } }); onSelect(event.target.value); }}><option value="">手动绑定到同类型对象…</option>{nodes.filter(node => node.id !== id && node.type === object.type && !edits.objects?.[node.id] && !node.locked).map(node => <option key={node.id} value={node.id}>{node.id}</option>)}</select></div>;
    })}</section>}
    {!!Object.keys(edits.instances || {}).length && <section><h3>实例覆盖记录</h3>{Object.entries(edits.instances || {}).map(([id, instance]) => <div className="program-override-record" key={id}><button onClick={() => onSelect(id)}>{id}</button><button onClick={() => onChange({ ...program, edits: { ...edits, instances: { ...edits.instances, [id]: { parameters: Object.fromEntries(Object.entries(instance.parameters).map(([name, track]) => [name, { ...track, locked: false }])) } } } })} disabled={!Object.values(instance.parameters).some(track => track.locked)}>解锁</button><button disabled={nodes.find(node => node.id === id)?.locked || Object.values(instance.parameters).some(track => track.locked)} onClick={() => { const instances = { ...edits.instances }; delete instances[id]; onChange({ ...program, edits: { ...edits, instances } }); }}>清除</button></div>)}</section>}
    <section><h3>工程模块</h3>{sources.map(path => <button className="program-module" key={path} onClick={() => onEdit(path)} title={path}>{path}</button>)}</section>
    <section><h3>{diagnostics.length ? '编译诊断' : '编译通过'}</h3>{diagnostics.map((item, index) => <p className="expression-error" key={index}><strong>{item.path}{item.line ? `:${item.line}:${item.column}` : ''}</strong><br />{item.message}</p>)}<small>初始化与资源加载跨帧复用；源代码、种子或资源修订变化时重建。</small></section>
  </div>;
}
