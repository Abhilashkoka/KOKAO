import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import kokaoLogo from "@assets/kokao-lockup-reversed_1783325983376.svg";

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 2600),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center bg-primary"
      initial={{ clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ clipPath: 'circle(150% at 50% 50%)' }}
      exit={{ opacity: 0, y: -50 }}
      transition={{ duration: 1.2, ease: [0.76, 0, 0.24, 1] }}
    >
      <div className="relative z-10 flex flex-col items-center">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="text-white/80 font-display text-[2vw] tracking-[0.2em] uppercase mb-[4vh]"
        >
          Meet your autopilot
        </motion.div>
        
        <motion.img 
          src={kokaoLogo} 
          alt="KOKAO Logo" 
          className="w-[40vw] max-w-[600px] h-auto"
          initial={{ opacity: 0, scale: 0.8, filter: 'blur(10px)' }}
          animate={phase >= 2 ? { opacity: 1, scale: 1, filter: 'blur(0px)' } : { opacity: 0, scale: 0.8, filter: 'blur(10px)' }}
          transition={{ type: "spring", stiffness: 200, damping: 20 }}
        />
      </div>
    </motion.div>
  );
}
