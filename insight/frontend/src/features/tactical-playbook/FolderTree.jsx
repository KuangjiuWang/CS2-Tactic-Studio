import { useState } from "react";
import { ChevronRight, Folder, MoreHorizontal, Plus, Library } from "lucide-react";
import { useT } from "../../i18n/useT";
import { mapLabel, TACTICAL_MAPS } from "./libraryModel";

export default function FolderTree({ folders, selected, map, select, selectMap, action, total }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(new Set());
  const [menu, setMenu] = useState(null);
  const renderFolder = (folder, depth = 0) => <div key={folder.id}>
    <div className={`playbook-folder ${selected === folder.id ? "is-selected" : ""}`} style={{ paddingLeft: 8 + depth * 16 }} onContextMenu={(e) => { e.preventDefault(); setMenu(folder.id); }}>
      <button aria-label={t(collapsed.has(folder.id) ? "playbook.expand" : "playbook.collapse")} aria-expanded={!collapsed.has(folder.id)} onClick={() => setCollapsed((old) => { const next = new Set(old); next.has(folder.id) ? next.delete(folder.id) : next.add(folder.id); return next; })}><ChevronRight size={13} style={{ transform: collapsed.has(folder.id) ? undefined : "rotate(90deg)" }} /></button>
      <button className="playbook-folder-name" onClick={() => select(folder.id)}><Folder size={15} /><span>{folder.name}</span></button>
      <button aria-label={`${t("playbook.actions")} ${folder.name}`} onClick={() => setMenu(menu === folder.id ? null : folder.id)}><MoreHorizontal size={15} /></button>
    </div>
    {menu === folder.id && <div className="playbook-folder-actions">{["newSubfolder", "rename", "move", "delete"].map((key) => <button key={key} onClick={() => { setMenu(null); action(key, folder); }}>{t(`playbook.${key}`)}</button>)}</div>}
    {!collapsed.has(folder.id) && folders.filter((child) => child.parent_id === folder.id).map((child) => renderFolder(child, depth + 1))}
  </div>;
  return <aside className="playbook-sidebar">
    <h2>{t("playbook.library")}</h2>
    <button className={`playbook-root ${!selected && !map ? "is-selected" : ""}`} onClick={() => { select(null); selectMap(""); }}><Library size={17} />{t("playbook.all")}<small>{total}</small></button>
    <details className="playbook-maps"><summary>{t("playbook.map")}</summary>{TACTICAL_MAPS.map((value) => <button className={!selected && map === value ? "is-selected" : ""} key={value} onClick={() => { select(null); selectMap(value); }}>{mapLabel(value)}</button>)}</details>
    <div className="playbook-section-title"><h2>{t("playbook.myFolders")}</h2><button aria-label={t("playbook.newFolder")} onClick={() => action("newFolder")}><Plus size={17} /></button></div>
    {folders.filter((folder) => !folder.parent_id).map((folder) => renderFolder(folder))}
    {!folders.length && <p className="playbook-hint">{t("playbook.folderHint")}</p>}
  </aside>;
}
