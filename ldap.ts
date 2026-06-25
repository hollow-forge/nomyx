import { Client } from 'ldapts';

const LDAP_URL   = process.env.LDAP_URL   ?? 'ldap://127.0.0.1:389';
const LDAP_BASE  = process.env.LDAP_BASE  ?? 'dc=nomyx,dc=local';
const LDAP_ADMIN = process.env.LDAP_ADMIN ?? 'cn=admin,dc=nomyx,dc=local';
const LDAP_PASS  = process.env.LDAP_PASS  ?? 'admin';

const GROUP_ROLE_MAP: Record<string, string> = {
  'Nomyx-GlobalAdmin': 'admin',
  'Nomyx-NOC':         'noc',
  'Nomyx-OIT-Viewer':  'viewer',
};

export interface LdapUser {
  dn:          string;
  email:       string;
  displayName: string;
  role:        string;
  groups:      string[];
}

// ── Authenticate (login flow — requires user password) ─────────────────────────

export async function ldapAuthenticate(
  username: string,
  password: string
): Promise<LdapUser | null> {
  const client = new Client({
    url:            LDAP_URL,
    connectTimeout: 5000,
    timeout:        5000,
  });

  try {
    await client.bind(LDAP_ADMIN, LDAP_PASS);

    const { searchEntries } = await client.search(LDAP_BASE, {
      scope:      'sub',
      filter:     `(|(uid=${username})(mail=${username}))`,
      attributes: ['dn', 'cn', 'mail'],
    });

    if (searchEntries.length === 0) return null;

    const entry       = searchEntries[0];
    const userDn      = entry.dn;
    const email       = String(entry.mail ?? '');
    const displayName = String(entry.cn   ?? username);

    // Bind as user to verify password
    await client.bind(userDn, password);

    // Re-bind as admin to search groups
    await client.bind(LDAP_ADMIN, LDAP_PASS);

    const { searchEntries: groupEntries } = await client.search(LDAP_BASE, {
      scope:      'sub',
      filter:     `(&(objectClass=groupOfNames)(member=${userDn}))`,
      attributes: ['cn'],
    });

    const groups = groupEntries.map(g => String(g.cn));

    let role = 'viewer';
    for (const [groupCn, mappedRole] of Object.entries(GROUP_ROLE_MAP)) {
      if (groups.includes(groupCn)) {
        role = mappedRole;
        break;
      }
    }

    return { dn: userDn, email, displayName, role, groups };
  } catch (err: any) {
    if (err?.code === 49) return null;
    console.error(`[ldap] error — code: ${err?.code}, message: ${err?.message}`);
    throw err;
  } finally {
    try { await client.unbind(); } catch { /* ignore */ }
  }
}

// ── Lookup (sync flow — admin bind only, no password needed) ───────────────────

export async function ldapLookupUser(
  email: string
): Promise<LdapUser | null> {
  const client = new Client({
    url:            LDAP_URL,
    connectTimeout: 5000,
    timeout:        5000,
  });

  try {
    await client.bind(LDAP_ADMIN, LDAP_PASS);

    const { searchEntries } = await client.search(LDAP_BASE, {
      scope:      'sub',
      filter:     `(mail=${email})`,
      attributes: ['dn', 'cn', 'mail'],
    });

    if (searchEntries.length === 0) return null;

    const entry       = searchEntries[0];
    const userDn      = entry.dn;
    const displayName = String(entry.cn ?? email);

    const { searchEntries: groupEntries } = await client.search(LDAP_BASE, {
      scope:      'sub',
      filter:     `(&(objectClass=groupOfNames)(member=${userDn}))`,
      attributes: ['cn'],
    });

    const groups = groupEntries.map(g => String(g.cn));

    let role = 'viewer';
    for (const [groupCn, mappedRole] of Object.entries(GROUP_ROLE_MAP)) {
      if (groups.includes(groupCn)) {
        role = mappedRole;
        break;
      }
    }

    return { dn: userDn, email: String(entry.mail ?? email), displayName, role, groups };
  } catch (err: any) {
    console.error(`[ldap-sync] lookup failed for ${email} — ${err?.message}`);
    return null;
  } finally {
    try { await client.unbind(); } catch { /* ignore */ }
  }
}