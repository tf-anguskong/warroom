import { useState, type ReactNode } from 'react';
import { useApp } from '../lib/app';

/**
 * Step-by-step setup instructions shown inside Admin → Settings and the integration dialogs. Every
 * address is this War Room's own (from the public address), and each value copies with a click.
 */

/** A value to paste somewhere else: monospace, click to copy. */
export function V({ children }: { children: string }) {
  const { toast } = useApp();
  return (
    <code
      className="guide-val"
      role="button"
      tabIndex={0}
      title="Click to copy"
      onClick={() => {
        void navigator.clipboard.writeText(children);
        toast({ text: 'Copied' }, 1200);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void navigator.clipboard.writeText(children);
          toast({ text: 'Copied' }, 1200);
        }
      }}
    >
      {children}
    </code>
  );
}

/** Fixed UI text the person clicks on in the other product. */
const B = ({ children }: { children: ReactNode }) => <strong>{children}</strong>;

export function SetupGuide({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  const [isOpen, setOpen] = useState(Boolean(open));
  return (
    <details className="setup-guide" open={isOpen} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Setup instructions for {title}</summary>
      <div className="setup-body">{children}</div>
    </details>
  );
}

const clean = (u: string) => (u || 'https://warroom.example.com').replace(/\/+$/, '');

// ---------- Admin → Settings ----------

export interface GuideContext {
  base: string;
  /** Draft values in the section being edited (for example the Entra protocol). */
  draft: Record<string, unknown>;
  /** Address values the server shows for this section (SAML identifier and the like). */
  info: { label: string; value: string }[];
  bundledLiveKit: boolean;
  open: boolean;
}

export function SettingsGuide({ section, ctx }: { section: string; ctx: GuideContext }) {
  const base = clean(ctx.base);
  const httpBase = !base.startsWith('https://');
  const httpsNote = httpBase && (
    <p className="guide-note warn-text">
      The public address is <V>{base}</V>. Identity providers need https for anything but local testing: set the address under <B>General</B> first.
    </p>
  );
  switch (section) {
    case 'okta':
      return (
        <SetupGuide title="Okta (OpenID Connect)" open={ctx.open}>
          {httpsNote}
          <h4>In the Okta Admin Console</h4>
          <ol>
            <li>
              <B>Applications → Applications → Create App Integration</B> → <B>OIDC - OpenID Connect</B> → <B>Web Application</B> → Next.
            </li>
            <li>
              Name it <V>War Room</V>. Grant type: <B>Authorization Code</B> (War Room uses PKCE; no other grants are needed).
            </li>
            <li>
              Sign-in redirect URI: <V>{`${base}/auth/callback`}</V>
              <br />
              Sign-out redirect URI: <V>{`${base}/login`}</V>
            </li>
            <li>
              Optional, so the Okta dashboard tile signs people straight in: <B>Login initiated by</B> <B>Either Okta or App</B>, <B>Display application icon to users</B>, and{' '}
              <B>Initiate login URI</B> <V>{`${base}/auth/login?provider=okta`}</V>.
            </li>
            <li>
              <B>Assignments</B>: choose who can use War Room (for example a <V>WarRoom-Users</V> group). Save.
            </li>
            <li>
              From the app’s <B>General</B> tab copy the <B>Client ID</B> and <B>Client secret</B>.
            </li>
            <li>
              Issuer: your org address, for example <V>https://your-org.okta.com</V>. If you use a custom authorization server instead, use its issuer from{' '}
              <B>Security → API → Authorization Servers</B> (for example <V>https://your-org.okta.com/oauth2/default</V>).
            </li>
            <li>
              Admins from a group (optional): app <B>Sign On</B> tab → <B>OpenID Connect ID Token</B> → Edit → Groups claim type <B>Filter</B>, name <V>groups</V>, filter{' '}
              <B>Starts with</B> <V>WarRoom</V>. (With a custom authorization server, add the <V>groups</V> claim under its <B>Claims</B> tab instead.)
            </li>
          </ol>
          <h4>In War Room (this form)</h4>
          <ol>
            <li>Paste the issuer, client ID and client secret.</li>
            <li>
              Admin group: the Okta group whose members are War Room admins, for example <V>WarRoom-Admins</V>.
            </li>
            <li>
              <B>Create accounts on first sign-in</B>: on if Okta doesn’t provision people over SCIM; off if it does (see <B>Provisioning (SCIM)</B>).
            </li>
            <li>
              <B>Test</B>, then <B>Save</B>. The sign-in page now shows <B>Sign in with Okta</B>.
            </li>
          </ol>
          <p className="guide-note">
            “User is not assigned to the client application” means the person isn’t assigned to the app in Okta (step 5).
          </p>
        </SetupGuide>
      );

    case 'entra': {
      const saml = ctx.draft['entra.protocol'] === 'saml';
      const entity = ctx.info.find((i) => /Entity ID/.test(i.label))?.value || `${base}/auth/saml/metadata`;
      return saml ? (
        <SetupGuide title="Microsoft Entra ID (SAML 2.0)" open={ctx.open}>
          {httpsNote}
          <h4>In the Microsoft Entra admin center</h4>
          <ol>
            <li>
              <B>Enterprise applications → New application → Create your own application</B>. Name it <V>War Room</V>, choose{' '}
              <B>Integrate any other application you don’t find in the gallery (Non-gallery)</B> → Create.
            </li>
            <li>
              In the new app: <B>Single sign-on → SAML</B>.
            </li>
            <li>
              <B>Basic SAML Configuration → Edit</B> and enter:
              <ul>
                <li>
                  Identifier (Entity ID): <V>{entity}</V>
                </li>
                <li>
                  Reply URL (Assertion Consumer Service URL): <V>{`${base}/auth/saml/acs`}</V>
                </li>
                <li>
                  Sign on URL: <V>{`${base}/auth/login?provider=entra`}</V>
                </li>
              </ul>
              Save. (Once SAML is saved here, War Room also serves its metadata at <V>{`${base}/auth/saml/metadata`}</V>, which Entra can import.)
            </li>
            <li>
              <B>Attributes & Claims</B>: keep the defaults. The unique user identifier (Name ID) should be <V>user.userprincipalname</V>; War Room matches people by
              object ID, then UPN, and never by the email claim.
            </li>
            <li>
              Admins from a group (optional): <B>Add a group claim → Security groups</B>, source attribute <B>Group ID</B>. Or create an app role such as{' '}
              <V>WarRoom.Admin</V> and assign it, which also works for people in more than ~150 groups.
            </li>
            <li>
              <B>SAML Certificates</B>: download <B>Certificate (Base64)</B>.
            </li>
            <li>
              <B>Users and groups → Add user/group</B>: assign who can sign in. Without an assignment Entra answers <V>AADSTS50105</V> (“user not assigned”).
            </li>
            <li>
              Copy the <B>Directory (tenant) ID</B> from the app’s <B>Overview</B> (or Entra ID → Overview).
            </li>
          </ol>
          <h4>In War Room (this form)</h4>
          <ol>
            <li>
              Tenant ID: the directory ID. Protocol: <B>SAML 2.0</B>.
            </li>
            <li>Token-signing certificate: open the downloaded .cer file in a text editor and paste all of it.</li>
            <li>Login URL and Identifier: leave empty unless you changed them in Entra.</li>
            <li>
              Admin group or app role: the group’s <B>Object ID</B>, or the app role value (<V>WarRoom.Admin</V>).
            </li>
            <li>
              <B>Test</B> (it shows the certificate’s subject and expiry), then <B>Save</B>.
            </li>
          </ol>
          <p className="guide-note">
            War Room only accepts sign-ins it started, so clicking the tile in My Apps must go through the Sign on URL above. The certificate expires (usually after 3
            years): renew it in Entra and paste the new one here before then.
          </p>
        </SetupGuide>
      ) : (
        <SetupGuide title="Microsoft Entra ID (OpenID Connect)" open={ctx.open}>
          {httpsNote}
          <h4>In the Microsoft Entra admin center</h4>
          <ol>
            <li>
              <B>App registrations → New registration</B>. Name <V>War Room</V>, <B>Accounts in this organizational directory only (Single tenant)</B>.
            </li>
            <li>
              Redirect URI: platform <B>Web</B>, <V>{`${base}/auth/callback`}</V> → Register.
            </li>
            <li>
              From <B>Overview</B> copy the <B>Application (client) ID</B> and <B>Directory (tenant) ID</B>.
            </li>
            <li>
              <B>Certificates & secrets → New client secret</B>. Copy its <B>Value</B> (not the Secret ID) straight away; Entra shows it once. Note when it expires.
            </li>
            <li>
              <B>Token configuration → Add optional claim → ID</B> → <V>email</V> (shown in War Room, never used to match accounts).
            </li>
            <li>
              Admins from a group (optional): <B>Token configuration → Add groups claim → Security groups</B> (ID token: Group ID). Or create an app role{' '}
              <V>WarRoom.Admin</V> under <B>App roles</B> and assign it in the enterprise application; better for people in many groups.
            </li>
            <li>
              Limit who can sign in (recommended): <B>Enterprise applications → War Room → Properties → Assignment required? Yes</B>, then <B>Users and groups → Add
              user/group</B>.
            </li>
          </ol>
          <h4>In War Room (this form)</h4>
          <ol>
            <li>
              Tenant ID, Protocol <B>OpenID Connect</B>, Application (client) ID and Client secret.
            </li>
            <li>
              Admin group or app role: the group’s <B>Object ID</B>, or <V>WarRoom.Admin</V>.
            </li>
            <li>
              <B>Create accounts on first sign-in</B>: off if Entra provisions people over SCIM.
            </li>
            <li>
              <B>Test</B>, then <B>Save</B>. The sign-in page now shows <B>Sign in with Microsoft</B>.
            </li>
          </ol>
          <p className="guide-note">
            Client secrets expire (6–24 months). Make a new one in Entra and paste it here before the old one runs out. <V>AADSTS50105</V> means the person isn’t
            assigned to the app.
          </p>
        </SetupGuide>
      );
    }

    case 'scim':
      return (
        <SetupGuide title="provisioning (SCIM 2.0)" open={ctx.open}>
          {httpsNote}
          <p>
            SCIM lets Okta or Entra create, update and deactivate War Room accounts. Deactivating someone there ends their War Room session at once. Set up sign-in
            first (Okta or Microsoft Entra ID), then:
          </p>
          <ol>
            <li>
              <B>Generate token</B> below and copy it; War Room shows it once. Generating a new one stops the old one.
            </li>
          </ol>
          <h4>Okta</h4>
          <ol>
            <li>
              In the War Room app: <B>General → App Settings → Edit</B> → Provisioning <B>SCIM</B> → Save.
            </li>
            <li>
              <B>Provisioning → Integration → Edit</B>:
              <ul>
                <li>
                  SCIM connector base URL: <V>{`${base}/scim/v2`}</V>
                </li>
                <li>
                  Unique identifier field for users: <V>userName</V>
                </li>
                <li>
                  Supported provisioning actions: <B>Push New Users</B>, <B>Push Profile Updates</B>, <B>Push Groups</B>
                </li>
                <li>
                  Authentication Mode: <B>HTTP Header</B>, Authorization: the token
                </li>
              </ul>
              <B>Test Connector Configuration</B>, then Save.
            </li>
            <li>
              <B>Provisioning → To App → Edit</B>: enable <B>Create Users</B>, <B>Update User Attributes</B>, <B>Deactivate Users</B> → Save.
            </li>
            <li>
              <B>Assignments</B>: assign people and groups. <B>Push Groups</B>: push the admin group (for example <V>WarRoom-Admins</V>) so admin rights follow it.
            </li>
          </ol>
          <h4>Microsoft Entra ID</h4>
          <ol>
            <li>
              <B>Enterprise applications</B> → the War Room app (the same one used for sign-in) → <B>Provisioning → Get started</B> → Provisioning Mode{' '}
              <B>Automatic</B>.
            </li>
            <li>
              Admin Credentials: Tenant URL <V>{`${base}/scim/v2`}</V> (no trailing slash), Secret Token: the token → <B>Test Connection</B> → Save.
            </li>
            <li>
              <B>Mappings</B>: keep the defaults. <V>userPrincipalName</V> → <V>userName</V> must stay, so provisioned accounts match sign-ins.
            </li>
            <li>
              <B>Settings → Scope</B>: <B>Sync only assigned users and groups</B>. <B>Provisioning Status: On</B> → Save.
            </li>
            <li>
              <B>Provision on demand</B> to check one person now; Entra then syncs about every 40 minutes.
            </li>
          </ol>
          <p className="guide-note">
            With SCIM on, turn off <B>Create accounts on first sign-in</B> in the Okta or Entra section, so only provisioned people can sign in. If you generate a new token,
            paste it into Okta or Entra again; syncing pauses until you do.
          </p>
        </SetupGuide>
      );

    case 'email':
      return (
        <SetupGuide title="email (SMTP)" open={ctx.open}>
          <p>War Room sends guest invites and sign-in codes. Any authenticated SMTP relay works; it must offer TLS.</p>
          <table className="guide-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Server / port / encryption</th>
                <th>Sign-in</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Microsoft 365</td>
                <td>
                  <V>smtp.office365.com</V> · 587 · STARTTLS
                </td>
                <td>A licensed mailbox with <B>Authenticated SMTP</B> turned on (Microsoft 365 admin center → user → Mail → Manage email apps). From address = that mailbox.</td>
              </tr>
              <tr>
                <td>Google Workspace</td>
                <td>
                  <V>smtp-relay.gmail.com</V> · 587 · STARTTLS
                </td>
                <td>Admin console → Apps → Gmail → <B>SMTP relay service</B>: allow this server’s IP address, or require SMTP authentication with a Workspace account.</td>
              </tr>
              <tr>
                <td>Amazon SES</td>
                <td>
                  <V>email-smtp.REGION.amazonaws.com</V> · 587 · STARTTLS
                </td>
                <td>SES → SMTP settings → Create SMTP credentials. The From address must be a verified identity.</td>
              </tr>
              <tr>
                <td>SendGrid</td>
                <td>
                  <V>smtp.sendgrid.net</V> · 587 · STARTTLS
                </td>
                <td>
                  Username <V>apikey</V>, password: an API key with Mail Send.
                </td>
              </tr>
            </tbody>
          </table>
          <ol>
            <li>Fill in the server, port, encryption, username, password and From address.</li>
            <li>
              <B>Test</B> checks the connection and login; <B>Save</B>; then <B>Admin → Integrations → Email (SMTP) → Send test email</B>.
            </li>
          </ol>
          <p className="guide-note">Codes not arriving? Check spam, and that the From address is allowed to send for your domain (SPF/DKIM).</p>
        </SetupGuide>
      );

    case 'voice':
      return (
        <SetupGuide title="voice (LiveKit)" open={ctx.open}>
          {ctx.bundledLiveKit ? (
            <>
              <p>This War Room runs its own LiveKit server, so the keys are already set. Voice, video and screen share need these open to the internet on this server:</p>
              <ul>
                <li>
                  TCP <V>443</V> (signalling, through Caddy on the same name)
                </li>
                <li>
                  TCP <V>7881</V> (media fallback)
                </li>
                <li>
                  UDP <V>50000-50100</V> (voice, video and screen share)
                </li>
              </ul>
              <p className="guide-note">
                If you use Cloudflare, the DNS record must be <B>DNS only</B>; media can’t go through its proxy. Networks that block UDP get chat but not voice.
              </p>
            </>
          ) : (
            <ol>
              <li>
                Run a LiveKit server (or LiveKit Cloud) and note its <V>wss://</V> address and an API key and secret.
              </li>
              <li>
                LiveKit address for browsers: the <V>wss://</V> address people’s browsers can reach.
              </li>
              <li>
                LiveKit address for the server: only if War Room should reach LiveKit by another address (for example an internal one); leave empty otherwise.
              </li>
              <li>
                API key and secret, then <B>Test</B>: it calls LiveKit’s API, which mute, move and remove rely on.
              </li>
            </ol>
          )}
        </SetupGuide>
      );

    case 'webhooks':
      return (
        <SetupGuide title="webhooks" open={ctx.open}>
          <p>
            Global webhooks are added under <B>Admin → Webhooks</B>; each war room’s own under <B>Webhooks</B> in its sidebar. Get the URL from the chat service:
          </p>
          <ul>
            <li>
              <B>Slack</B>: api.slack.com/apps → your app → <B>Incoming Webhooks</B> → Add New Webhook to Workspace → pick a channel. Starts with{' '}
              <V>https://hooks.slack.com/services/</V>
            </li>
            <li>
              <B>Microsoft Teams</B>: in the channel, <B>⋯ → Workflows → Post to a channel when a webhook request is received</B>, finish the wizard and copy the URL.
            </li>
            <li>
              <B>Discord</B>: channel <B>Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL</B>.
            </li>
            <li>
              <B>Mattermost</B>: <B>Integrations → Incoming Webhooks → Add Incoming Webhook</B>. If Mattermost is on your internal network, turn on{' '}
              <B>Allow internal addresses</B> below.
            </li>
            <li>
              <B>Generic JSON</B>: any https endpoint. Check each request’s <V>X-WarRoom-Signature</V> (sha256 HMAC of <V>timestamp.body</V> with the signing secret).
            </li>
          </ul>
          <p className="guide-note">Use the webhook’s Test button after adding it.</p>
        </SetupGuide>
      );

    case 'agents':
      return (
        <SetupGuide title="AI agents (MCP)" open={ctx.open}>
          <p>
            Agents connect to <V>{`${base}/mcp`}</V> and act for the person who approves them.
          </p>
          <ul>
            <li>
              <B>Claude (web, desktop, mobile)</B>: Settings → Connectors → <B>Add custom connector</B> → <V>{`${base}/mcp`}</V> → Connect, then approve in War Room.
              Claude connects from the internet, so this address must be public https.
            </li>
            <li>
              <B>Claude Code</B>: <V>{`claude mcp add --transport http warroom ${base}/mcp`}</V>, then <V>/mcp</V> → warroom → Authenticate.
            </li>
            <li>
              <B>Without sign-in</B> (command-line agents, War Room NOW, guests): each person creates a key in the war room under <B>AI agents → Your agent key</B>.
            </li>
          </ul>
        </SetupGuide>
      );

    default:
      return null;
  }
}

// ---------- Admin → Integrations ----------

export function IntegrationGuide({ type, open }: { type: string; open: boolean }) {
  if (type === 'okta') {
    return (
      <SetupGuide title="the Okta integration" open={open}>
        <p>This is for looking people up and searching the System Log in the Investigate view; it isn’t sign-in (that’s under Settings → Okta).</p>
        <ol>
          <li>
            Create a service account in Okta (for example <V>svc-warroom</V>) and give it the <B>Read-Only Administrator</B> role (<B>Security → Administrators → Add
            administrator</B>).
          </li>
          <li>
            Signed in as that account: <B>Security → API → Tokens → Create token</B>, name it <V>War Room</V>, and copy the token (shown once).
          </li>
          <li>
            Okta org URL: <V>https://your-org.okta.com</V> (the admin address without <V>-admin</V>).
          </li>
          <li>
            Paste both below and <B>Connect & test</B>.
          </li>
        </ol>
        <p className="guide-note">
          API tokens act with the account’s rights and expire after 30 days without use. If you restrict tokens by network zone, allow this server’s IP address.
        </p>
      </SetupGuide>
    );
  }
  if (type === 'sumo') {
    return (
      <SetupGuide title="Sumo Logic" open={open}>
        <ol>
          <li>
            In Sumo Logic: <B>Administration → Users and Roles → Roles</B>. Create a role that can search the data you want investigated and has no admin
            capabilities, and give it to a service user (for example <V>svc-warroom</V>).
          </li>
          <li>
            As that user: <B>Preferences (your name) → My Access Keys → Add Access Key</B>. Copy the Access ID and Access Key (the key is shown once).
          </li>
          <li>
            Pick your <B>deployment</B> below: it’s in your Sumo address (for example <V>service.us2.sumologic.com</V> is US2).
          </li>
          <li>
            Paste the Access ID and Key and <B>Connect & test</B>. Then add starter queries with placeholders such as <V>{'{{ip}}'}</V> and <V>{'{{user}}'}</V>.
          </li>
        </ol>
      </SetupGuide>
    );
  }
  if (type === 'crowdstrike') {
    return (
      <SetupGuide title="CrowdStrike Falcon" open={open}>
        <ol>
          <li>
            In Falcon: <B>Support and resources → API clients and keys → Create API client</B>, name <V>War Room</V>.
          </li>
          <li>
            Scopes: <B>Hosts: Read</B> and <B>Alerts: Read</B> only.
          </li>
          <li>Copy the Client ID and Secret (the secret is shown once) and note the Base URL Falcon shows.</li>
          <li>
            Choose the matching <B>Falcon cloud</B> below (for example <V>https://api.us-2.crowdstrike.com</V> is US-2), paste the client ID and secret, and{' '}
            <B>Connect & test</B>.
          </li>
        </ol>
        <p className="guide-note">War Room only reads hosts and alerts. Containment stays in Falcon and shows up in the war room within a minute.</p>
      </SetupGuide>
    );
  }
  return null;
}
