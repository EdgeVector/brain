import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A config cutover must reach disk before the converter resumes app requests. */
export function writeConfigFile(path:string,text:string):void {
  const temporary=path+".next-"+randomUUID();
  let renamed=false;
  try {
    writeFileSync(temporary,text,{encoding:"utf8",mode:0o600,flag:"wx"});
    const file=openSync(temporary,"r");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary,path);
    renamed=true;
    const directory=openSync(dirname(path),"r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (!renamed) { try { unlinkSync(temporary); } catch { /* No temporary file was created. */ } }
  }
}
