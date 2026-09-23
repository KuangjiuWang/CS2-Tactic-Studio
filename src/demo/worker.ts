import { parseDemo } from './parser';
const [file,output]=process.argv.slice(2);
parseDemo(file,output,message=>process.send?.({type:'progress',message})).then(match=>{process.send?.({type:'done',match});process.exit(0);}).catch(error=>{process.send?.({type:'error',message:String(error)});console.error(error);process.exit(1);});
