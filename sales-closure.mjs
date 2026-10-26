// Prepared closing release. This module takes effect only after owner-approved deployment.
// Do not mount on auth, materials, provider callbacks, or access fulfillment.
export function rejectClosedSales(req,res,next) {
  if(req.method==='OPTIONS')return next();
  return res.set('Cache-Control','no-store').status(403).json({
    code:'SALES_CLOSED',
    message:'Продажи закрыты'
  });
}
