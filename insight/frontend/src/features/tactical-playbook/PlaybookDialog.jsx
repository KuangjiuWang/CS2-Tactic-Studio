import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { descendants, folderIds, folderPath } from "./libraryModel";

export default function PlaybookDialog({ dialog, folders, close, submit, busy }) {
  const t = useT(), ref = useRef(null);
  const [name, setName] = useState(dialog.item?.name || "");
  const [selected, setSelected] = useState(folderIds(dialog.item || {}));
  const [parent, setParent] = useState(dialog.item?.parent_id || "");
  useEffect(() => { ref.current?.showModal(); }, []);
  const forbidden = dialog.action === "move" ? descendants(dialog.item.id, folders) : new Set();
  const isPicker = dialog.action === "addToFolder";
  return <dialog ref={ref} className="playbook-dialog" onCancel={(e) => { e.preventDefault(); if (!busy) close(); }}><form onSubmit={(e) => { e.preventDefault(); submit({ name, selected, parent: parent || null }); }}>
    <h2>{t(`playbook.${dialog.action}`)}</h2>
    {dialog.action === "delete" ? <p>{t(dialog.kind === "folders" ? "playbook.deleteFolderHint" : "playbook.deleteTacticHint")}</p>
      : isPicker ? <div className="playbook-picker">{folders.map((folder) => <label key={folder.id}><input type="checkbox" checked={selected.includes(folder.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, folder.id] : selected.filter((id) => id !== folder.id))} />{folderPath(folder, folders)}</label>)}{!folders.length && <p>{t("playbook.folderHint")}</p>}</div>
      : dialog.action === "move" ? <select aria-label={t("playbook.destination")} value={parent} onChange={(e) => setParent(e.target.value)}><option value="">{t("playbook.myFolders")}</option>{folders.filter((folder) => !forbidden.has(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>)}</select>
      : <input autoFocus required maxLength={200} aria-label={t("playbook.name")} value={name} onChange={(e) => setName(e.target.value)} />}
    {dialog.error && <p role="alert">{dialog.error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>{t("playbook.cancel")}</button><button className="playbook-primary" disabled={busy || (!["delete", "move", "addToFolder"].includes(dialog.action) && !name.trim())}>{t(busy ? "playbook.saving" : "playbook.confirm")}</button></footer>
  </form></dialog>;
}
