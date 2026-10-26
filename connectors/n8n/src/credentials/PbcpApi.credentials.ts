import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/** A head's base URL and a producer token (RFC §7). The token is bound to one producer root. */
export class PbcpApi implements ICredentialType {
  name = 'pbcpApi';
  displayName = 'PBCP Head';
  documentationUrl = 'https://github.com/morkeleb/pbcp/tree/main/connectors/n8n';
  properties: INodeProperties[] = [
    { displayName: 'Head URL', name: 'headUrl', type: 'string', default: '', required: true, placeholder: 'https://head.example' },
    { displayName: 'Token', name: 'token', type: 'string', typeOptions: { password: true }, default: '', required: true },
  ];
  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.token}}' } },
  };
  /** Describe (§7.5): any head answers `GET /`. */
  test: ICredentialTestRequest = {
    request: { baseURL: '={{$credentials.headUrl.replace(/\\/+$/, "")}}', url: '/' },
  };
}
