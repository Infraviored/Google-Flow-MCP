import { FlowError, ErrorCodes } from '../utils/errors.js';

// Flow (flow.google.com, since Oct 2026) is an Angular "boq" app. Its data
// comes from Google's batchexecute endpoint, not the old labs.google tRPC API.
// Every call is a POST with f.req=[[[rpcId, JSON(args), null, "generic"]]] and
// the page's XSRF token (WIZ_global_data.SNlM0e). Running the fetch inside the
// page keeps cookies, token and headers exactly what Flow itself sends.
//
// RPC ids seen live (args → result):
//   UpteDb  ["projects/*",21,null,null,null,null,[1]]      → project list
//   Zzl0ze  ["projects/<pid>",null,null,null,[1]]          → generations (workflows) of a project
//   bOKtO   [null,[workflowId…],[1]]                       → media of those workflows, with prompt
//   as29s   [mediaId]                                      → media with a signed full-size URL
//   vrrFtb  [null,pid,[workflowId…]]                       → workflow title + primary media
export async function rpc(page, rpcId, args) {
  if (!page.url().startsWith('https://flow.google.com/')) {
    throw new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED, `RPC ${rpcId} needs a flow.google.com page, current: ${page.url()}`);
  }
  const out = await page.evaluate(async ({ rpcId, args }) => {
    const g = window.WIZ_global_data || {};
    if (!g.SNlM0e) return { error: 'no XSRF token on page (not signed in?)' };
    const params = new URLSearchParams({
      rpcids: rpcId,
      'source-path': location.pathname,
      bl: g.cfb2h || '',
      'f.sid': g.FdrFJe || '',
      hl: 'en',
      _reqid: String(Math.floor(Math.random() * 900000) + 100000),
      rt: 'c',
    });
    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]),
      at: g.SNlM0e,
    });
    const res = await fetch(`/_/AiSandboxAngularFrontend/data/batchexecute?${params}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
      body,
    });
    return { status: res.status, text: await res.text() };
  }, { rpcId, args });

  if (out.error) throw new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED, `RPC ${rpcId}: ${out.error}`);
  if (out.status !== 200) {
    throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `RPC ${rpcId} returned HTTP ${out.status} — Flow's API may have changed.`);
  }
  // Response: ")]}'" then length-prefixed JSON chunks; the one we want is
  // ["wrb.fr", rpcId, "<json payload>", ...].
  for (const line of out.text.split('\n')) {
    if (!line.startsWith('[')) continue;
    let chunk;
    try { chunk = JSON.parse(line); } catch { continue; }
    for (const entry of chunk) {
      if (entry?.[0] === 'wrb.fr' && entry[1] === rpcId) {
        if (entry[2] == null) {
          throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `RPC ${rpcId} returned an error: ${JSON.stringify(entry).slice(0, 300)}`);
        }
        try {
          return JSON.parse(entry[2]);
        } catch (err) {
          throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `RPC ${rpcId} returned malformed JSON payload: ${err.message}`);
        }
      }
    }
  }
  throw new FlowError(ErrorCodes.UNKNOWN_UI_CHANGE, `RPC ${rpcId}: no result in response`);
}
