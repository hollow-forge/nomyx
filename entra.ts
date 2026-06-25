import * as msal from "@azure/msal-node";

export const REDIRECT_URI = () => process.env.ENTRA_REDIRECT_URI!;
export const SCOPES       = ["openid", "profile", "email", "User.Read"];

function getClient(): msal.ConfidentialClientApplication {
  return new msal.ConfidentialClientApplication({
    auth: {
      clientId:     process.env.ENTRA_CLIENT_ID!,
      clientSecret: process.env.ENTRA_CLIENT_SECRET!,
      authority:    `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}`
    }
  });
}

export async function getAuthUrl(): Promise<string> {
  return getClient().getAuthCodeUrl({
    scopes:      SCOPES,
    redirectUri: REDIRECT_URI()
  });
}

export async function handleCallback(code: string): Promise<any> {
  const result = await getClient().acquireTokenByCode({
    code,
    scopes:      SCOPES,
    redirectUri: REDIRECT_URI()
  });
  return result;
}