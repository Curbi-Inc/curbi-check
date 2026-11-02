import {wrapLanguageModel} from 'ai';
import {curbiMiddleware, checkReply, CurbiCheckError} from '@curbi/vercel';
declare const model:Parameters<typeof wrapLanguageModel>[0]['model'];
const policy={prices:[{item:'Pro',amount:49}]};
wrapLanguageModel({model,middleware:curbiMiddleware({policy})});
checkReply('Pro is $49.',{policy}).then(result=>result.findings.forEach(f=>f.span[0].toFixed()));
const error:Error=new CurbiCheckError('findings');
void error;
