import { useEffect, useRef, useState } from 'react';
import type { LayoutPreferences } from '../adapters/browser-layout';
import { BRAND_IMAGE_MAX_BYTES, BRAND_NAME_MAX, DISPLAY_NAME_MAX, EMAIL_MAX, SESSION_NAMING_GUIDANCE_MAX, sameIdentityBaseline, validateAvatarImage, validateBrandImage, validateBrandName, validateDisplayName, validateEmail, validateSessionNamingGuidance, type IdentityBaseline, type IdentityPreferences } from '../adapters/browser-identity';
import type { ThemePreference } from '../domain/types';
import { Modal } from '../ui/Modal';
import { announceIdentitySaved, useBrowserIdentity } from './useBrowserIdentity';
import { AvatarCrop, type AvatarCropHandle } from './AvatarCrop';
import { readAvatarImage } from './avatar-crop';
import './user-options.css';
import { useDeskRuntime } from '../app/runtime';

const sameIdentity = (left: IdentityPreferences, right: IdentityPreferences) => left.brandName === right.brandName && left.displayName === right.displayName && left.brandImage === right.brandImage && left.sessionNamingGuidance === right.sessionNamingGuidance
  && (left.email ?? '') === (right.email ?? '') && (left.avatarImage ?? null) === (right.avatarImage ?? null);
type OptionsPage = 'help' | 'appearance' | 'user';

export function UserOptions({ page, theme, layout, onTheme, onLayout, onClose, onNavigate, warning }: {
  page: OptionsPage; theme: ThemePreference; layout: LayoutPreferences;
  onTheme: (theme: ThemePreference) => void; onLayout: (value: Partial<LayoutPreferences>) => void;
  onClose: () => void; onNavigate?: (page: OptionsPage) => void; warning: string | null;
}) {
  const runtime = useDeskRuntime();
  const ephemeral = runtime.mode === 'native-proof';
  const identity = useBrowserIdentity();
  const [preferences, setPreferences] = useState(identity.preferences);
  const [baseline, setBaseline] = useState(identity.preferences);
  const [baselineRaw, setBaselineRaw] = useState<IdentityBaseline | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingNow = useRef(false);
  const mounted = useRef(true);
  const [identityMessage, setIdentityMessage] = useState('');
  const [imagePending, setImagePending] = useState(false);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarSource, setAvatarSource] = useState<HTMLImageElement | null>(null);
  const avatarCrop = useRef<AvatarCropHandle>(null);
  const avatarRead = useRef(0);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const imageRead = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; imageRead.current += 1; avatarRead.current += 1; }; }, []);
  useEffect(() => {
    if (discardPrompt) {
      keepEditing.current?.focus();
      keepEditing.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [discardPrompt]);
  useEffect(() => {
    if (!identity.ready || loaded) return;
    setPreferences(identity.preferences); setBaseline(identity.preferences); setBaselineRaw(identity.baseline); setLoaded(true);
  }, [identity, loaded]);
  const dirty = !sameIdentity(preferences, baseline) || imagePending || avatarPending || !!avatarSource || saving;
  const changedElsewhere = loaded && identity.ready && !sameIdentityBaseline(identity.baseline, baselineRaw);
  const identityReadOnly = !loaded || !identity.ready || identity.readOnly || changedElsewhere;
  const requestClose = () => {
    if (savingNow.current) { setIdentityMessage('Saving browser identity. Wait for it to finish before closing.'); return; }
    if (dirty) {
      setDiscardPrompt(true);
      // A repeated close request must also reveal an already-open decision.
      keepEditing.current?.focus();
      keepEditing.current?.scrollIntoView({ block: 'nearest' });
      return;
    }
    onClose();
  };
  const chooseImage = async (file: File | undefined) => {
    if (!file || identityReadOnly || savingNow.current) return;
    const request = ++imageRead.current;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > BRAND_IMAGE_MAX_BYTES) {
      setIdentityMessage('Choose a PNG, JPEG or WebP image up to 512 KB.');
      setImagePending(false);
      return;
    }
    setImagePending(true);
    setIdentityMessage('Checking image…');
    try {
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('The image could not be read.'));
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The image could not be read.'));
        reader.readAsDataURL(file);
      });
      const problem = validateBrandImage(source);
      if (problem) throw new Error(problem);
      const image = new Image();
      image.src = source;
      await image.decode();
      if (request !== imageRead.current) return;
      setPreferences((current) => ({ ...current, brandImage: source }));
      setIdentityMessage(ephemeral ? 'Image ready. Save identity to keep it for this visit.' : 'Image ready. Save identity to keep it in this browser.');
    } catch {
      if (request === imageRead.current) setIdentityMessage('Choose a readable PNG, JPEG or WebP image up to 512 KB.');
    } finally {
      if (request === imageRead.current) setImagePending(false);
    }
  };
  const chooseAvatar = async (file: File | undefined) => {
    if (!file || identityReadOnly || savingNow.current) return;
    const request = ++avatarRead.current;
    setAvatarPending(true); setIdentityMessage('Checking photo…');
    try {
      const image = await readAvatarImage(file);
      if (!mounted.current || request !== avatarRead.current) return;
      setAvatarSource(image); setIdentityMessage('Adjust the crop, then Save identity to keep your photo and profile.');
    } catch (error) {
      if (mounted.current && request === avatarRead.current) setIdentityMessage(error instanceof Error ? error.message : 'The photo could not be read.');
    } finally {
      if (mounted.current && request === avatarRead.current) setAvatarPending(false);
    }
  };
  return <Modal title={page === 'help' ? 'Help and application options' : page === 'appearance' ? 'Appearance options' : 'User options'} onClose={requestClose} scrollable>
    <div className="user-settings" data-preview-refresh-hold={dirty ? 'browser-identity' : undefined}>
      {ephemeral && <p role="status">Identity, photos and rail layout preferences last for this visit only.</p>}
      {discardPrompt && <div className="settings-warning" role="alert"><p>Your identity changes are not saved. Keep editing or discard them before closing.</p>
        <div className="modal-actions"><button ref={keepEditing} type="button" className="primary-button" onClick={() => setDiscardPrompt(false)}>Keep editing</button>
          <button type="button" className="text-button" disabled={saving} onClick={onClose}>Discard changes</button></div></div>}
      {onNavigate && <nav className="settings-shortcuts" aria-label="Options pages">
        {(['user', 'appearance', 'help'] as const).filter((value) => value !== page).map((value) => <button type="button" key={value} disabled={saving}
          onClick={() => { setDiscardPrompt(false); onNavigate(value); }}>{value === 'user' ? 'User options' : value === 'appearance' ? 'Appearance options' : 'Help'}</button>)}
      </nav>}
      {page !== 'user' && dirty && <p className="settings-warning" role="status">Your profile edits are kept here. Return to User options to save them.</p>}
      <section hidden={page !== 'help'} className="settings-help"><h3>Find your way around</h3>
        <p>Session folders organize topics, projects or goals. Sessions outside those folders live in Ungrouped sessions. Open a folder to find its conversations.</p>
        <p>Navigator and Canvas show the same sample records. Atlas is planned as a 3D knowledge view. Rail Map shows a saved snapshot of this project's branches and pull requests. Use Codex annotations to point out what needs to change.</p>
      </section>
      <form hidden={page !== 'user'} className="identity-settings" onSubmit={async (event) => {
        event.preventDefault();
        if (identityReadOnly || imagePending || avatarPending || savingNow.current) return;
        let snapshot = preferences;
        if (avatarSource) {
          try {
            if (!avatarCrop.current) throw new Error('The photo crop is not ready.');
            snapshot = { ...preferences, avatarImage: avatarCrop.current.render() };
          } catch (error) {
            setIdentityMessage(error instanceof Error ? error.message : 'The photo could not be cropped.');
            return;
          }
        }
        const invalid = validateBrandName(snapshot.brandName) ?? validateDisplayName(snapshot.displayName) ?? validateBrandImage(snapshot.brandImage)
          ?? validateSessionNamingGuidance(snapshot.sessionNamingGuidance) ?? validateEmail(snapshot.email ?? '') ?? validateAvatarImage(snapshot.avatarImage ?? null);
        if (invalid) { setIdentityMessage(invalid); return; }
        savingNow.current = true; setSaving(true); setIdentityMessage(ephemeral ? 'Keeping identity for this visit…' : 'Saving browser identity…');
        try {
          const result = await runtime.identity.save(snapshot, baselineRaw);
          if (!runtime.isActive() || !mounted.current) return;
          if (!result.saved) { setIdentityMessage(result.warning); return; }
          setPreferences(result.preferences); setBaseline(result.preferences); setBaselineRaw(result.baseline); setDiscardPrompt(false); setAvatarSource(null);
          setIdentityMessage(ephemeral ? 'Identity kept for this visit.' : 'Browser identity saved.'); announceIdentitySaved();
        } catch {
          if (mounted.current) setIdentityMessage('Display settings could not be saved. Previous saved settings were kept.');
        } finally {
          savingNow.current = false;
          if (mounted.current) setSaving(false);
        }
      }}>
        <fieldset disabled={identityReadOnly || saving}><legend>{ephemeral ? 'Identity for this visit' : 'Browser identity'}</legend>
          <p className="field-hint">{ephemeral ? 'Your profile and workspace preferences last for this visit only.' : 'Your profile and workspace preferences stay in this browser.'}</p>
          <label htmlFor="identity-brand-name">Workspace name</label>
          <input id="identity-brand-name" value={preferences.brandName} maxLength={BRAND_NAME_MAX} onChange={(event) => { setPreferences({ ...preferences, brandName: event.target.value }); setIdentityMessage(''); }} />
          <label htmlFor="identity-display-name">Display name</label>
          <input id="identity-display-name" value={preferences.displayName} maxLength={DISPLAY_NAME_MAX} onChange={(event) => { setPreferences({ ...preferences, displayName: event.target.value }); setIdentityMessage(''); }} />
          <label htmlFor="identity-email">Email address (optional)</label>
          <input id="identity-email" type="email" value={preferences.email ?? ''} maxLength={EMAIL_MAX} autoComplete="email"
            aria-describedby="identity-email-help" onChange={(event) => { setPreferences({ ...preferences, email: event.target.value }); setIdentityMessage(''); }} />
          <p id="identity-email-help" className="field-hint">Your email stays off the navigation rail. It does not connect or verify an account.</p>
          <label htmlFor="identity-avatar-image">Profile photo</label>
          <input id="identity-avatar-image" type="file" accept="image/png,image/jpeg,image/webp" disabled={avatarPending || !!avatarSource}
            onChange={(event) => { void chooseAvatar(event.target.files?.[0]); event.target.value = ''; }} />
          <p className="field-hint">PNG, JPEG or WebP, up to 10 MB. Zoom and move the photo to choose its circular crop.</p>
          {avatarPending && <button type="button" className="text-button" onClick={() => { avatarRead.current += 1; setAvatarPending(false); setIdentityMessage('Photo selection canceled.'); }}>Cancel photo selection</button>}
          {avatarSource && <AvatarCrop ref={avatarCrop} image={avatarSource} disabled={identityReadOnly || saving} onApply={(avatarImage) => {
            setPreferences((current) => ({ ...current, avatarImage })); setAvatarSource(null); setIdentityMessage('Photo ready. Save identity to keep it in this browser.');
          }} onCancel={() => { avatarRead.current += 1; setAvatarSource(null); setIdentityMessage('Crop canceled. Your previous profile photo is kept.'); }} />}
          {preferences.avatarImage && !avatarSource && <div className="identity-avatar-preview"><img src={preferences.avatarImage} alt="Profile photo preview" />
            <button type="button" className="text-button" disabled={avatarPending} onClick={() => { setPreferences({ ...preferences, avatarImage: null }); setIdentityMessage(''); }}>Remove profile photo</button></div>}
          <label htmlFor="identity-brand-image">Workspace image</label>
          <input id="identity-brand-image" type="file" accept="image/png,image/jpeg,image/webp" disabled={imagePending}
            onChange={(event) => { void chooseImage(event.target.files?.[0]); event.target.value = ''; }} />
          <p className="field-hint">PNG, JPEG or WebP, up to 512 KB.</p>
          {preferences.brandImage && <div className="identity-image-preview"><img src={preferences.brandImage} alt="Workspace image preview" />
            <button type="button" className="text-button" disabled={imagePending} onClick={() => { setPreferences({ ...preferences, brandImage: null }); setIdentityMessage(''); }}>Remove image</button></div>}
          <label htmlFor="identity-session-naming">Future session naming guidance</label>
          <textarea id="identity-session-naming" value={preferences.sessionNamingGuidance} maxLength={SESSION_NAMING_GUIDANCE_MAX} rows={3}
            aria-describedby="identity-session-naming-help" onChange={(event) => { setPreferences({ ...preferences, sessionNamingGuidance: event.target.value }); setIdentityMessage(''); }} />
          <p id="identity-session-naming-help" className="field-hint">{ephemeral ? 'Optional note for this visit and future agent naming.' : 'Optional browser-local note for future agent naming.'} Automatic session naming is planned; this guidance does not rename sessions.</p>
        </fieldset>
        <div className="modal-actions"><button type="submit" className="primary-button" disabled={identityReadOnly || imagePending || avatarPending || saving || !dirty}>Save identity</button>
          {dirty && !discardPrompt && <button type="button" className="text-button" disabled={saving} onClick={onClose}>Discard changes</button>}</div>
        {identity.warning && <p className="settings-warning" role="status">{identity.warning}</p>}
        {changedElsewhere && <p className="settings-warning" role="status">Browser identity changed in another window. Close and reopen User options before saving; your edits are still shown here.</p>}
        {identityMessage && <p className="identity-save-message" role="status">{identityMessage}</p>}
      </form>
      {page === 'appearance' && <fieldset><legend>Appearance</legend>
        <div className="settings-choices">{(['light', 'dark', 'system'] as const).map((value) => <label key={value}>
          <input type="radio" name="appearance" checked={theme === value} onChange={() => onTheme(value)} />
          <span>{value === 'system' ? 'Follow system' : value === 'light' ? 'Light' : 'Dark'}</span>
        </label>)}</div>
        <p className="field-hint">Follow system uses your device or browser appearance setting.</p>
      </fieldset>}
      <fieldset><legend>Navigation rail</legend>
        {([
          ['expanded', 'Expanded', 'Keep the full rail visible with titles.'],
          ['icons', 'Icons only', 'Keep a compact rail visible. Titles appear as tooltips.'],
          ['hover', 'Expand on hover', 'Show icons, then expand when you hover or use the keyboard.'],
          ['hidden', 'Hide completely', 'Show no rail icons. Use Navigation in the header, the left edge, or ⌘ / Ctrl + \\.'],
        ] as const).map(([value, label, description]) => <label className="rail-setting" key={value}>
          <input type="radio" name="navigation-rail" checked={layout.mode === value} onChange={() => onLayout({ mode: value })} />
          <span><strong>{label}</strong><span>{description}</span></span>
        </label>)}
      </fieldset>
      <p className="field-hint">Drag a vertical divider to resize it, or focus it and use the arrow keys. Widths snap near preset sizes.</p>
      {warning && <p className="settings-warning" role="status">{warning}</p>}
      <button type="button" className="primary-button" onClick={requestClose}>Close options</button>
    </div>
  </Modal>;
}
