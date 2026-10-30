// The server checks both the account permission and this file's access rules.
// Do not infer sharing authority from file ownership or a displayed role name.
export async function configureSharingAction({ button, hint, request, entryId, isCurrent, translate }) {
  button.disabled = true;
  hint.hidden = false;
  hint.textContent = translate('sharingChecking');
  try {
    const response = await request(`/api/v1/files/entries/${entryId}/shares`);
    if (!Array.isArray(response?.data)) throw new Error('invalid_share_list');
    if (!isCurrent()) return;
    button.disabled = false;
    hint.hidden = true;
    hint.textContent = '';
  } catch (error) {
    if (!isCurrent()) return;
    hint.textContent = translate(error?.status === 403 || error?.status === 404 ? 'sharingDenied' : 'sharingUnavailable');
  }
}
