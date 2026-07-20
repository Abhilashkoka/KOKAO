import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 1800),
      setTimeout(() => setPhase(4), 2600),
      setTimeout(() => setPhase(5), 3600),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  const features = [
    { title: "Brand Kits", desc: "Always on-brand.", delay: 0 },
    { title: "AI Captions", desc: "Perfect tone every time.", delay: 0.1 },
    { title: "Content Library", desc: "Organized and ready.", delay: 0.2 },
    { title: "Scheduling", desc: "Plan ahead seamlessly.", delay: 0.3 },
  ];

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-start pl-[10vw]"
      initial={{ opacity: 0, x: '100vw' }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ x: '-100vw', opacity: 0 }}
      transition={{ duration: 0.8, ease: [0.76, 0, 0.24, 1] }}
    >
      <div className="relative z-10 w-[40vw]">
        <motion.h2 
          className="text-[4vw] font-display font-bold text-white mb-[4vh]"
          initial={{ opacity: 0, x: -20 }}
          animate={phase >= 1 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
          transition={{ duration: 0.6 }}
        >
          Everything you need.
        </motion.h2>

        <div className="flex flex-col gap-[2vh]">
          {features.map((f, i) => (
            <motion.div 
              key={i}
              className="bg-white/5 border border-white/10 rounded-2xl p-[2vh] backdrop-blur-md"
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={phase >= 2 ? { opacity: 1, x: 0, scale: 1 } : { opacity: 0, x: 50, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 400, damping: 30, delay: f.delay }}
            >
              <h3 className="text-[1.8vw] font-display font-bold text-accent">{f.title}</h3>
              <p className="text-[1.2vw] text-text-secondary">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
      
      {/* Abstract Right side visual */}
      <motion.div 
        className="absolute right-[10vw] w-[30vw] h-[30vw] border-4 border-primary/30 rounded-full"
        initial={{ opacity: 0, scale: 0.5, rotate: -90 }}
        animate={phase >= 3 ? { opacity: 1, scale: 1, rotate: 0 } : { opacity: 0, scale: 0.5, rotate: -90 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      >
        <motion.div 
          className="absolute inset-[10%] border-4 border-accent/50 rounded-full"
          animate={{ rotate: 360 }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
        />
        <motion.div 
          className="absolute inset-[20%] border-4 border-white/80 rounded-full border-dashed"
          animate={{ rotate: -360 }}
          transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
        />
      </motion.div>
    </motion.div>
  );
}
