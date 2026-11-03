declare const validate: {
  (value:unknown):boolean;
  errors?:{instancePath:string;keyword:string}[]|null;
};
export default validate;
