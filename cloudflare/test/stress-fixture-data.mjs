// Deterministic synthetic data for the stress estimate tests and sample fixture.
// No real user data.
export function day(n){return new Date(Date.UTC(2026,8,1)+n*86400000).toISOString().slice(0,10);}
export function syntheticUser({days=45,seed=1,stressFrom=40,prefix="u"}={}){
  const recoveries=[],sleeps=[];
  let x=seed;
  const rnd=()=>{x=(x*1103515245+12345)%2147483648;return x/2147483648;};
  for(let i=0;i<days;i++){
    const stressed=i>=stressFrom;
    const id=`${prefix}-sleep-${i}`;
    sleeps.push({id,start:day(i-1)+"T23:00:00Z",end:day(i)+"T06:30:00Z",nap:false,score_state:"SCORED",score:{
      sleep_performance_percentage:Math.round((stressed?68:88)+rnd()*6),
      sleep_efficiency_percentage:Math.round((stressed?84:92)+rnd()*3),
      respiratory_rate:+((stressed?16.4:15.0)+rnd()*0.4).toFixed(1),
      stage_summary:{total_light_sleep_time_milli:Math.round((stressed?3.0:3.6)*3600000),
        total_slow_wave_sleep_time_milli:Math.round(1.4*3600000),total_rem_sleep_time_milli:Math.round((stressed?1.2:1.7)*3600000)}}});
    recoveries.push({cycle_id:10000+i,sleep_id:id,created_at:day(i)+"T07:00:00Z",score_state:"SCORED",score:{
      user_calibrating:false,recovery_score:Math.round((stressed?35:70)+rnd()*10),
      hrv_rmssd_milli:+((stressed?42:62)+rnd()*6).toFixed(2),
      resting_heart_rate:Math.round((stressed?61:54)+rnd()*2),
      skin_temp_celsius:+(33.4+rnd()*0.3).toFixed(2)}});
  }
  return {recoveries,sleeps};
}
