export default function HowItWorks() {
  return (
    <section className="strip">
      <span className="eyebrow">How it works</span>
      <h2>Two lanes, one pool</h2>
      <p className="sub">
        One pool lives on Solana, and both kinds of wallets trade it. Same liquidity, same
        prices, same fees — no bridge, nothing wrapped.
      </p>

      <div className="lanes">
        <div className="lane evm">
          <p className="cap">EVM lane</p>
          <div className="flow">
            EVM wallet
            <span className="arrow">→</span>
            Rome EVM
            <span className="arrow">→</span>
            <span className="tag evm">one tx</span>
          </div>
          <p className="desc">
            Trade from your EVM wallet exactly as you would anywhere else — it reaches the
            Solana pool inside the same, single transaction.
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
            Trade from your Solana wallet straight against the pool — no detour, same
            liquidity, same prices.
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
