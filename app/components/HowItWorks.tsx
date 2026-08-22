export default function HowItWorks() {
  return (
    <section className="strip">
      <span className="eyebrow">How it works</span>
      <h2>Two lanes, one pool</h2>
      <p className="sub">
        One pool lives on Solana, and both kinds of wallets trade it, at the same prices
        and fees. No bridge and nothing wrapped.
      </p>

      <div className="lanes">
        <div className="lane evm">
          <p className="cap">EVM lane</p>
          <div className="flow">
            EVM wallet
            <span className="arrow">→</span>
            Rome EVM
            <span className="arrow">→</span>
            <span className="tag evm">one pool</span>
          </div>
          <p className="desc">
            Trade from your EVM wallet exactly as you would anywhere else. Your trade lands
            on the same Solana pool, against the same state.
          </p>
        </div>

        <div className="converge" aria-hidden="true">⇄</div>

        <div className="lane sol">
          <p className="cap">Solana lane</p>
          <div className="flow">
            Solana wallet
            <span className="arrow">→</span>
            Pool program
            <span className="tag sol" style={{ marginLeft: 8 }}>
              direct
            </span>
          </div>
          <p className="desc">
            Trade from your Solana wallet straight against the pool. Same liquidity and
            prices as the EVM lane.
          </p>
        </div>
      </div>

      <div className="samepool">
        <span className="box">
          <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "#2faa6a", marginRight: 8, verticalAlign: "middle" }} />
          Both lanes settle the same pool
        </span>
      </div>
    </section>
  );
}
