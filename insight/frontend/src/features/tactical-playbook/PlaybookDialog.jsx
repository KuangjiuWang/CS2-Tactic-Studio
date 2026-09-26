import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { descendants, folderIds, folderPath } from "./libraryModel";
import { TACTIC_CATEGORIES, TACTIC_SITES, TACTIC_UTILITIES, TACTIC_RESULTS } from "./libraryModel";

function parseTags(value) {
  const seen = new Set();
  return value.split(",").map((tag) => tag.trim()).filter((tag) => {
    const normalized = tag.toLowerCase();
    if (!tag || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export default function PlaybookDialog({ dialog, folders, close, submit, busy }) {
  const t = useT(), ref = useRef(null);
  const [name, setName] = useState(dialog.item?.name || "");
  const [selected, setSelected] = useState(folderIds(dialog.item || {}));
  const [parent, setParent] = useState(dialog.item?.parent_id || "");
  const [classification, setClassification] = useState(() => ({
    category: "", site: "", utility: [], result: "", tags: [],
    ...(dialog.item?.metadata?.classification || {}),
  }));
  const [tagText, setTagText] = useState((dialog.item?.metadata?.classification?.tags || []).join(", "));
  useEffect(() => { ref.current?.showModal(); }, []);
  const forbidden = dialog.action === "move" ? descendants(dialog.item.id, folders) : new Set();
  const isPicker = dialog.action === "addToFolder";
  const isClassifier = dialog.action === "classify";
  const tags = parseTags(tagText);
  const tagsTooMany = tags.length > 20;
  const tagsTooLong = tags.some((tag) => tag.length > 40);
  const setField = (key, value) => setClassification((current) => ({ ...current, [key]: value }));
  return <dialog ref={ref} className="playbook-dialog" onCancel={(e) => { e.preventDefault(); if (!busy) close(); }}><form onSubmit={(e) => { e.preventDefault(); if (tagsTooMany || tagsTooLong) return; submit({ name, selected, parent: parent || null, classification: { ...classification, tags } }); }}>
    <h2>{t(`playbook.${dialog.action}`)}</h2>
    {dialog.action === "delete" ? <p>{t(dialog.kind === "folders" ? "playbook.deleteFolderHint" : "playbook.deleteTacticHint")}</p>
      : isPicker ? <div className="playbook-picker">{folders.map((folder) => <label key={folder.id}><input type="checkbox" checked={selected.includes(folder.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, folder.id] : selected.filter((id) => id !== folder.id))} />{folderPath(folder, folders)}</label>)}{!folders.length && <p>{t("playbook.folderHint")}</p>}</div>
      : dialog.action === "move" ? <select aria-label={t("playbook.destination")} value={parent} onChange={(e) => setParent(e.target.value)}><option value="">{t("playbook.myFolders")}</option>{folders.filter((folder) => !forbidden.has(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folderPath(folder, folders)}</option>)}</select>
      : isClassifier ? <div className="playbook-classification-form">
        <label>{t("playbook.category")}<select aria-label={t("playbook.category")} value={classification.category || ""} onChange={(e) => setField("category", e.target.value || null)}><option value="">{t("playbook.unclassified")}</option>{TACTIC_CATEGORIES.map((value) => <option key={value} value={value}>{t(`playbook.category.${value}`)}</option>)}</select></label>
        <label>{t("playbook.site")}<select aria-label={t("playbook.site")} value={classification.site || ""} onChange={(e) => setField("site", e.target.value || null)}><option value="">{t("playbook.unknown")}</option>{TACTIC_SITES.map((value) => <option key={value} value={value}>{t(`playbook.site.${value}`)}</option>)}</select></label>
        <label>{t("playbook.result")}<select aria-label={t("playbook.result")} value={classification.result || ""} onChange={(e) => setField("result", e.target.value || null)}><option value="">{t("playbook.unknown")}</option>{TACTIC_RESULTS.map((value) => <option key={value} value={value}>{t(`playbook.result.${value}`)}</option>)}</select></label>
        <fieldset><legend>{t("playbook.utilityFilter")}</legend><div className="playbook-utility-options">{TACTIC_UTILITIES.map((value) => <label key={value}><input type="checkbox" checked={(classification.utility || []).includes(value)} onChange={(e) => setField("utility", e.target.checked ? [...(classification.utility || []), value] : (classification.utility || []).filter((item) => item !== value))} />{t(`playbook.utility.${value}`)}</label>)}</div></fieldset>
        <label>{t("playbook.customTags")}<input aria-label={t("playbook.customTags")} maxLength={838} value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder={t("playbook.tagsHint")} /></label>
        {tagsTooMany && <p role="alert">{t("playbook.tagsTooMany")}</p>}
        {tagsTooLong && <p role="alert">{t("playbook.tagTooLong")}</p>}
      </div>
      : <input autoFocus required maxLength={200} aria-label={t("playbook.name")} value={name} onChange={(e) => setName(e.target.value)} />}
    {dialog.error && <p role="alert">{dialog.error}</p>}
    <footer><button type="button" disabled={busy} onClick={close}>{t("playbook.cancel")}</button><button className="playbook-primary" disabled={busy || (isClassifier && (tagsTooMany || tagsTooLong)) || (!isClassifier && !["delete", "move", "addToFolder"].includes(dialog.action) && !name.trim())}>{t(busy ? "playbook.saving" : "playbook.confirm")}</button></footer>
  </form></dialog>;
}
